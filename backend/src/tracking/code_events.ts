/**
 * Server-side Code-Mint-Event-Logger.
 *
 * Schreibt einen reinen Timestamp pro frisch geminteten 9-stelligen Code.
 * Keine PII (kein Code-Wert, keine IP, keine User-ID) — nur "es wurde
 * mal wieder ein Code erzeugt". Komplement zum Matomo-Counter in
 * tracking/matomo.ts; die DB-Variante ist die verlaesslichere Quelle,
 * weil sie nicht von einem externen System abhaengt.
 *
 * Failure-Path ist intentional silent: ein gescheitertes INSERT darf
 * den Code-Mint-Flow NIE blockieren.
 */

import type { Db } from "../db.js";

/**
 * Schreibt ein Code-Event mit `createdAt` (ms since epoch). Bei Fehler
 * (DB locked, Tabelle fehlt nach manuellem Pruefen, …) wird der Fehler
 * geschluckt — Code-Mint hat Vorrang.
 */
export function recordCodeCreated(db: Db, createdAt: number): void {
  try {
    db.prepare("INSERT INTO code_events (created_at) VALUES (?)").run(createdAt);
  } catch {
    // bewusst leise — Counter-Schreiben darf den Mint nicht killen.
  }
}

/** Aggregate Statistik-Antwort fuer den Admin-Endpoint. */
export interface CodeStats {
  total: number;
  last24h: number;
  last7d: number;
  last30d: number;
  /**
   * Letzte 30 Tage als `{day: "YYYY-MM-DD", count}`-Liste, neuester
   * Tag zuerst. Tage ohne Mints sind NICHT im Array — der Caller fuellt
   * sie ggf. mit 0er-Stuetzen fuer eine kontinuierliche Zeitachse.
   */
  perDay: Array<{ day: string; count: number }>;
}

/**
 * Liest die kummulierten + Windowed-Counts aus `code_events`. `now` wird
 * uebergeben (nicht `Date.now()` intern), damit Tests deterministisch
 * sind.
 */
export function queryCodeStats(db: Db, now: number): CodeStats {
  const d24 = now - 24 * 60 * 60 * 1000;
  const d7 = now - 7 * 24 * 60 * 60 * 1000;
  const d30 = now - 30 * 24 * 60 * 60 * 1000;

  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM code_events").get() as { n: number }
  ).n;
  const last24h = (
    db
      .prepare("SELECT COUNT(*) AS n FROM code_events WHERE created_at >= ?")
      .get(d24) as { n: number }
  ).n;
  const last7d = (
    db
      .prepare("SELECT COUNT(*) AS n FROM code_events WHERE created_at >= ?")
      .get(d7) as { n: number }
  ).n;
  const last30d = (
    db
      .prepare("SELECT COUNT(*) AS n FROM code_events WHERE created_at >= ?")
      .get(d30) as { n: number }
  ).n;

  const perDay = (
    db
      .prepare<[number], { day: string; count: number }>(
        `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS count
         FROM code_events
         WHERE created_at >= ?
         GROUP BY day
         ORDER BY day DESC`,
      )
      .all(d30)
  );

  return { total, last24h, last7d, last30d, perDay };
}
