import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.js";

const MAX_RANGE_DAYS = 90;

function bad(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: code, message });
}

/**
 * Parse a "YYYY-MM-DD" date in UTC. Returns a Date set to 00:00:00 UTC, or
 * null if the string isn't a well-formed ISO date.
 */
function parseUtcDate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** Convert a Date to a "YYYY-MM-DD" string in UTC. */
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (
    let t = from.getTime();
    t <= to.getTime();
    t += 24 * 60 * 60 * 1000
  ) {
    out.push(fmtDate(new Date(t)));
  }
  return out;
}

export function registerAdminTimeseriesRoutes(app: FastifyInstance, db: Db): void {
  app.get(
    "/api/admin/stats/timeseries",
    { preHandler: [app.requireSession, app.requireAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as { from?: string; to?: string };
      if (!q.from || !q.to) return bad(reply, 400, "bad-range", "from + to required (YYYY-MM-DD)");
      const from = parseUtcDate(q.from);
      const to = parseUtcDate(q.to);
      if (!from || !to) return bad(reply, 400, "bad-range", "dates must be YYYY-MM-DD");
      if (from.getTime() > to.getTime()) return bad(reply, 400, "bad-range", "from must be ≤ to");

      const days = daysBetween(from, to);
      if (days.length > MAX_RANGE_DAYS)
        return bad(reply, 400, "bad-range", `range capped at ${MAX_RANGE_DAYS} days`);

      const fromMs = from.getTime();
      const toMs = to.getTime() + 24 * 60 * 60 * 1000; // inclusive end-of-day

      // signups per day
      const signupRows = db
        .prepare<
          [number, number],
          { date: string; n: number }
        >(
          `SELECT DATE(created_at / 1000, 'unixepoch') AS date, COUNT(*) AS n
             FROM accounts
            WHERE created_at >= ? AND created_at < ? AND deleted_at IS NULL
            GROUP BY date`,
        )
        .all(fromMs, toMs);

      // connections per day, split by type
      const connRows = db
        .prepare<
          [number, number],
          { date: string; p2p: number; relay: number; bytes: number }
        >(
          `SELECT DATE(started_at / 1000, 'unixepoch') AS date,
                  SUM(CASE WHEN connection_type = 'p2p' THEN 1 ELSE 0 END) AS p2p,
                  SUM(CASE WHEN connection_type = 'relay' THEN 1 ELSE 0 END) AS relay,
                  COALESCE(SUM(CASE WHEN connection_type = 'relay' THEN bytes_relayed ELSE 0 END), 0) AS bytes
             FROM connection_log
            WHERE started_at >= ? AND started_at < ?
            GROUP BY date`,
        )
        .all(fromMs, toMs);

      // Map for O(1) lookup when filling empty days
      const signupByDate = new Map(signupRows.map((r) => [r.date, r.n]));
      const connByDate = new Map(connRows.map((r) => [r.date, r]));

      const signups = days.map((d) => ({ date: d, n: signupByDate.get(d) ?? 0 }));
      const connections = days.map((d) => {
        const r = connByDate.get(d);
        return {
          date: d,
          p2p: r?.p2p ?? 0,
          relay: r?.relay ?? 0,
        };
      });
      const relay_bytes = days.map((d) => ({
        date: d,
        bytes: connByDate.get(d)?.bytes ?? 0,
      }));

      return reply.send({ signups, connections, relay_bytes });
    },
  );
}
