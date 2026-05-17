/**
 * Self-hosted Matomo server-side counter.
 *
 * Used to record an aggregate "how often is Auffi being used" event from
 * the backend — specifically: how often was a 9-digit code minted. No
 * client IP, no user ID, no URL, no UA — Matomo only ever sees a counter
 * tick. See docs/encryption-architecture.md and viewer/public/datenschutz
 * for the public-facing disclosure.
 *
 * Failure path is intentionally silent: if Matomo is unreachable or
 * returns 5xx, the calling Code-Mint flow MUST NOT break.
 */

export type MatomoConfig = {
  /** Full URL to matomo.php, e.g. "https://musikersuche.org/matomo/matomo.php". Empty disables tracking. */
  trackerUrl: string;
  /** Matomo site_id as string, e.g. "6". Empty disables tracking. */
  siteId: string;
};

export type MatomoTracker = {
  trackCodeCreated(): Promise<void>;
};

const NOOP: MatomoTracker = {
  async trackCodeCreated() {
    /* no-op */
  },
};

export function createMatomoTracker(cfg: MatomoConfig): MatomoTracker {
  if (!cfg.trackerUrl || !cfg.siteId) return NOOP;

  return {
    async trackCodeCreated(): Promise<void> {
      const body = new URLSearchParams({
        idsite: cfg.siteId,
        rec: "1",
        apiv: "1",
        e_c: "session",
        e_a: "code_created",
        rand: String(Date.now()),
      });

      try {
        await fetch(cfg.trackerUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });
      } catch {
        // Intentional swallow — Matomo outage must never break code creation.
      }
    },
  };
}

export function matomoTrackerFromEnv(): MatomoTracker {
  return createMatomoTracker({
    trackerUrl: process.env.MATOMO_TRACKER_URL ?? "",
    siteId: process.env.MATOMO_SITE_ID ?? "",
  });
}
