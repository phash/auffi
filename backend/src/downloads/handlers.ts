import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.js";

/**
 * Public download counters surfaced on /download/.
 *
 * `KNOWN_ASSETS` is the allow-list — the file proxy 404s for anything
 * else so we can't be flooded with arbitrary asset_name rows. When a new
 * release ships:
 *   1) upload the new artefacts to the GitHub release
 *   2) bump this list to match the asset filenames
 *   3) bump viewer/public/download/index.html to point at them
 * Counts persist across releases — old assets keep their tallies, the
 * GET endpoint returns whatever rows exist for the listed names.
 */
export const KNOWN_ASSETS: ReadonlySet<string> = new Set([
  // 0.6.4 — released 2026-07-02, das derzeit EINZIGE Release auf GitHub
  // (ältere Releases wurden dort gelöscht). Sharer reliability: unattended
  // multi-viewer fix, heartbeat reconnect-backoff reset, free-tier warning,
  // x11 capture logs via dbg_log. Linux + Windows via CI (release.yml).
  // Portable now also built by CI (build-sharer.yml stages
  // target/release/auffi-sharer.exe) — served ?tag=v0.6.4-pinned (the
  // portable is not latest-tracked).
  "Auffi_0.6.4_amd64.deb",
  "Auffi-0.6.4-1.x86_64.rpm",
  "Auffi_0.6.4_amd64.AppImage",
  "Auffi_0.6.4_x64-setup.exe",
  "Auffi_0.6.4_x64_en-US.msi",
  "Auffi_0.6.4_x64_portable.exe",
  // 0.6.3 — released 2026-06-22. VP8 realtime-encoder tuning fixes laggy
  // capture on Windows servers / RDP / GPU-less hosts. Linux + Windows via CI.
  "Auffi_0.6.3_amd64.deb",
  "Auffi-0.6.3-1.x86_64.rpm",
  "Auffi_0.6.3_amd64.AppImage",
  "Auffi_0.6.3_x64-setup.exe",
  "Auffi_0.6.3_x64_en-US.msi",
  // Portable single-exe — built locally (the release CI only bundles NSIS +
  // MSI), uploaded to the v0.6.3 release manually. Served ?tag=v0.6.3-pinned.
  "Auffi_0.6.3_x64_portable.exe",
  // 0.6.2 — released 2026-06-22. Windows capture fix (COM apartment + GDI/RDP
  // fallback for E_NOINTERFACE), visible code-expiry, security hardening.
  "Auffi_0.6.2_amd64.deb",
  "Auffi-0.6.2-1.x86_64.rpm",
  "Auffi_0.6.2_amd64.AppImage",
  "Auffi_0.6.2_x64-setup.exe",
  "Auffi_0.6.2_x64_en-US.msi",
  // 0.6.0 — released 2026-06-16. Geo-country in confirm dialog, Calm-Fresh
  // sharer recast, security guards. Release inzwischen auf GitHub gelöscht —
  // Eintrag bleibt nur für die Counter-Persistenz (Upstream-Fetch → 502).
  "Auffi_0.6.0_amd64.deb",
  "Auffi-0.6.0-1.x86_64.rpm",
  "Auffi_0.6.0_amd64.AppImage",
  "Auffi_0.6.0_x64-setup.exe",
  "Auffi_0.6.0_x64_en-US.msi",
  // 0.5.0 — released 2026-05-29. Security + UX review. Linux built locally,
  // Windows via the build box; promoted to `latest` once all 6 were uploaded.
  "Auffi_0.5.0_amd64.deb",
  "Auffi-0.5.0-1.x86_64.rpm",
  "Auffi_0.5.0_amd64.AppImage",
  "Auffi_0.5.0_x64-setup.exe",
  "Auffi_0.5.0_x64_en-US.msi",
  // 0.4.5 — released 2026-05-21. Update-Notifier + Download-Proxy
  // (Downloads laufen direkt über auffi.app, Counter wird server-side
  // beim Stream-Start gebumpt). Linux + Windows ab dem ersten Tag.
  "Auffi_0.4.5_amd64.deb",
  "Auffi-0.4.5-1.x86_64.rpm",
  "Auffi_0.4.5_amd64.AppImage",
  "Auffi_0.4.5_x64-setup.exe",
  "Auffi_0.4.5_x64_en-US.msi",
  // 0.4.4 — Counter-Persistenz; Hrefs gibt's nicht mehr in download/.
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

/**
 * Defence-in-depth for the `Content-Disposition` filename. `asset` is
 * already constrained to `KNOWN_ASSETS` (all `[A-Za-z0-9._-]`), so this
 * is a no-op today — but it means a future allow-list entry containing a
 * quote or CR/LF can never turn into a response-header injection.
 */
function safeFilename(asset: string): string {
  return asset.replace(/[^A-Za-z0-9._-]/g, "_");
}

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
   * 30/min/IP — counter-flooding wants the per-IP cap, and a determined
   * user wouldn't download a 200 MB file 30× per minute anyway.
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

      // HEAD-Short-Circuit: link-preview-Crawler oder Monitoring sollen
      // weder den Download-Counter bumpen noch die volle Datei aus dem
      // Upstream durchstreamen. Real-Downloads kommen über GET. Headers
      // entsprechen einem hypothetischen erfolgreichen GET, damit
      // `curl -I` und Uptime-Checker korrekt informiert sind.
      if (req.method === "HEAD") {
        reply.header("content-type", "application/octet-stream");
        reply.header("content-disposition", `attachment; filename="${safeFilename(asset)}"`);
        return reply.status(200).send();
      }

      const upstream = await upstreamFetcher(asset, tag);
      if (!upstream.ok || !upstream.body) {
        // Release the connection: a non-ok response with a body (GitHub
        // 404 page, S3 error XML) would otherwise keep the undici stream
        // reserved until GC under repeated failures.
        void upstream.body?.cancel().catch(() => {});
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

      // Force `application/octet-stream` independent of upstream's
      // Content-Type — defence-in-depth gegen MIME-Confusion. Sollte
      // GitHubs S3-CDN jemals einen 2xx mit text/html-Body liefern
      // (Edge-Case: CDN-Fehler-Page mit 200-Statuscode), würde der
      // Browser ihn als HTML rendern wenn wir den Header
      // weiterleiten. Attachment-Disposition + octet-stream zwingt
      // den Download-Pfad immer, egal was der Upstream sagt.
      reply.header("content-type", "application/octet-stream");
      reply.header("content-disposition", `attachment; filename="${safeFilename(asset)}"`);
      // Plus expliziter nosniff fuer die direkte Antwort — der Caddy-
      // Reverse-Proxy setzt das ohnehin global, aber doppelt haelt
      // besser und macht den Schutz auf der Route sichtbar.
      reply.header("x-content-type-options", "nosniff");
      const len = upstream.headers.get("content-length");
      if (len) reply.header("content-length", len);

      return reply.send(upstream.body);
    },
  );
}
