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
  // 0.4.1 — released 2026-05-17, contains the #97 input-cleanup fix.
  "Auffi_0.4.1_amd64.deb",
  "Auffi-0.4.1-1.x86_64.rpm",
  "Auffi_0.4.1_amd64.AppImage",
  // Portable .exe + NSIS setup carry no version stamp — stable across releases.
  "auffi-sharer-windows-x64.exe",
  "auffi-sharer-windows-x64-setup.exe",
  "Auffi_0.4.1_x64_en-US.msi",
]);

export function registerDownloadRoutes(app: FastifyInstance, db: Db): void {
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
}
