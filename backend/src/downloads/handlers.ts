import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.js";

/**
 * Public download counters surfaced on /download/.
 *
 * `KNOWN_ASSETS` is the allow-list — the POST endpoint 404s for anything
 * else so we can't be flooded with arbitrary asset_name rows. When a new
 * release ships:
 *   1) upload the new artefacts to the GitHub release
 *   2) bump this list to match the asset filenames
 *   3) bump viewer/public/download/index.html to point at them
 * Counts persist across releases — old assets keep their tallies, the
 * GET endpoint returns whatever rows exist for the listed names.
 */
export const KNOWN_ASSETS: ReadonlySet<string> = new Set([
  // 0.4.5 — released 2026-05-21. Update-Notifier + Download-Proxy
  // (Downloads laufen jetzt direkt über auffi.app, Counter wird
  // server-side beim Stream-Start gebumpt). Linux-only; Windows-Builds
  // (Setup/MSI/portable) bleiben vorerst auf v0.4.4 gepinnt via
  // ?tag=v0.4.4 in den download/-Hrefs, bis der Windows-Build von der
  // separaten Build-Box nachrollt.
  "Auffi_0.4.5_amd64.deb",
  "Auffi-0.4.5-1.x86_64.rpm",
  "Auffi_0.4.5_amd64.AppImage",
  // 0.4.4 — Windows-Hrefs sind via ?tag=v0.4.4 gepinnt; Linux-Einträge
  // gehalten für Counter-Persistenz (alte Klicks bleiben sichtbar).
  "Auffi_0.4.4_amd64.deb",
  "Auffi-0.4.4-1.x86_64.rpm",
  "Auffi_0.4.4_amd64.AppImage",
  "Auffi_0.4.4_x64-setup.exe",
  "Auffi_0.4.4_x64_en-US.msi",
  // 0.4.3 + 0.4.2 — gehalten für Counter-Persistenz + Backwards-Compat
  // von gecachten URLs.
  "Auffi_0.4.3_amd64.deb",
  "Auffi-0.4.3-1.x86_64.rpm",
  "Auffi_0.4.3_amd64.AppImage",
  "Auffi_0.4.2_amd64.deb",
  "Auffi-0.4.2-1.x86_64.rpm",
  "Auffi_0.4.2_amd64.AppImage",
  "auffi-sharer-windows-x64.exe",
  "auffi-sharer-windows-x64-setup.exe",
  "Auffi_0.4.2_x64_en-US.msi",
]);

/**
 * Where the proxy fetches release assets from. Production points at the
 * GitHub-releases CDN; tests inject a stub so they neither hit the
 * network nor depend on the actual asset being uploaded.
 *
 * If `tag` is provided, the asset is fetched from that specific release
 * tag (`/releases/download/<tag>/<asset>`). Otherwise it falls back to
 * the symlink (`/releases/latest/download/<asset>`). Pinning is needed
 * when an asset only exists in a prior release (e.g. Windows builds
 * lagging behind Linux releases) — without it, a `latest`-link would
 * 404 once `latest` no longer carries that asset.
 *
 * `follow` on redirect: GitHub 302s the request to the S3-CDN URL with
 * the actual bytes.
 */
function defaultUpstreamFetcher(asset: string, tag?: string): Promise<Response> {
  const slug = tag
    ? `releases/download/${encodeURIComponent(tag)}`
    : "releases/latest/download";
  return fetch(`https://github.com/phash/auffi/${slug}/${encodeURIComponent(asset)}`, {
    redirect: "follow",
  });
}

/**
 * Allow only `vMAJOR.MINOR.PATCH` tags. Stops a malicious request from
 * pointing `?tag=` at an arbitrary URL fragment (`?tag=../../../etc`).
 * The proxy still URL-encodes the segment, but defence-in-depth.
 */
const VALID_TAG = /^v\d+\.\d+\.\d+$/;

export interface DownloadRoutesOptions {
  /** Inject a custom upstream fetcher (used by tests). */
  upstreamFetcher?: (asset: string, tag?: string) => Promise<Response>;
}

export function registerDownloadRoutes(
  app: FastifyInstance,
  db: Db,
  opts: DownloadRoutesOptions = {},
): void {
  const upstreamFetcher = opts.upstreamFetcher ?? defaultUpstreamFetcher;
  /**
   * GET /api/downloads — public, returns the click-count for every
   * known asset (zero for assets nobody has clicked yet so the viewer
   * can render a stable list without conditional template logic).
   */
  app.get("/api/downloads", async (_req: FastifyRequest, reply: FastifyReply) => {
    const rows = db
      .prepare<[], { asset_name: string; count: number }>(
        "SELECT asset_name, count FROM download_counts",
      )
      .all();
    const counts: Record<string, number> = {};
    for (const a of KNOWN_ASSETS) counts[a] = 0;
    for (const r of rows) {
      if (KNOWN_ASSETS.has(r.asset_name)) counts[r.asset_name] = r.count;
    }
    return reply.status(200).send({ counts });
  });

  /**
   * POST /api/downloads/:asset — increment the click-counter for `asset`.
   * Rate-limited per IP (the global rate-limit applies; the cap here is
   * tighter so a misclicking bot can't run the count into the millions).
   * 404 on unknown asset names so the table can't be flooded with
   * arbitrary keys.
   */
  app.post(
    "/api/downloads/:asset",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { asset } = req.params as { asset: string };
      if (!asset || !KNOWN_ASSETS.has(asset)) {
        return reply
          .status(404)
          .send({ error: "unknown-asset", message: "asset is not on the allow-list" });
      }
      const now = Date.now();
      db.prepare(
        `INSERT INTO download_counts (asset_name, count, updated_at)
              VALUES (?, 1, ?)
         ON CONFLICT (asset_name) DO UPDATE
              SET count = count + 1, updated_at = excluded.updated_at`,
      ).run(asset, now);
      const after = db
        .prepare<[string], { count: number }>(
          "SELECT count FROM download_counts WHERE asset_name = ?",
        )
        .get(asset)!;
      return reply.status(200).send({ ok: true, count: after.count });
    },
  );

  /**
   * GET /api/downloads/file/:asset — stream-through proxy.
   *
   * Replaces the client-side fire-and-forget POST + GH-redirect pattern
   * with a server-side stream so (a) the counter increments are
   * authoritative (no JS dependency, no double-count from refresh)
   * and (b) the user-visible download URL stays on auffi.app.
   *
   * Counter is only bumped AFTER upstream returns 2xx so a Github
   * outage / bad asset name doesn't inflate the metric.
   *
   * Same rate-limit cap as the POST endpoint — argon2-DoS / counter-
   * flooding both want the per-IP cap, and a determined user wouldn't
   * download a 200 MB file 30× per minute anyway.
   */
  app.get<{ Params: { asset: string }; Querystring: { tag?: string } }>(
    "/api/downloads/file/:asset",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { asset } = req.params;
      if (!asset || !KNOWN_ASSETS.has(asset)) {
        return reply
          .status(404)
          .send({ error: "unknown-asset", message: "asset is not on the allow-list" });
      }
      const tag = req.query.tag;
      if (tag !== undefined && !VALID_TAG.test(tag)) {
        return reply
          .status(400)
          .send({ error: "invalid-tag", message: "tag must match vMAJOR.MINOR.PATCH" });
      }

      const upstream = await upstreamFetcher(asset, tag);
      if (!upstream.ok || !upstream.body) {
        return reply
          .status(502)
          .send({ error: "upstream-unavailable", message: "could not fetch asset" });
      }

      const now = Date.now();
      db.prepare(
        `INSERT INTO download_counts (asset_name, count, updated_at)
              VALUES (?, 1, ?)
         ON CONFLICT (asset_name) DO UPDATE
              SET count = count + 1, updated_at = excluded.updated_at`,
      ).run(asset, now);

      reply.header(
        "content-type",
        upstream.headers.get("content-type") ?? "application/octet-stream",
      );
      reply.header("content-disposition", `attachment; filename="${asset}"`);
      const len = upstream.headers.get("content-length");
      if (len) reply.header("content-length", len);

      return reply.send(upstream.body);
    },
  );
}
