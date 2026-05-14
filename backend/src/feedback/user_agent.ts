/**
 * Reduce a full User-Agent string to a "Browser-Family/OS-Family" hint.
 *
 * The feedback table only needs enough UA context for an admin to
 * spot "this Bug-Report came from a Safari/iOS user" — not the full
 * version-string fingerprint that turns the entry into a tracking
 * vector (Security-Review L-2, 2026-05-14).
 *
 * Pure regex + small whitelist; deliberately doesn't pull in
 * `ua-parser-js` (which would be 50 KB of regexes + a maintenance
 * burden for a handful of values). Falls back to "unknown" when
 * neither browser nor OS can be identified — that's the right
 * answer when the UA is empty or comes from a bot.
 */
export function truncateUserAgent(raw: string | undefined | null): string {
  if (!raw) return "unknown";
  const ua = raw.slice(0, 1000);
  const browser = detectBrowser(ua);
  const os = detectOs(ua);
  if (browser === "unknown" && os === "unknown") return "unknown";
  if (browser === "unknown") return os;
  if (os === "unknown") return browser;
  return `${browser}/${os}`;
}

function detectBrowser(ua: string): string {
  // Order matters: Edge/Chrome's UA contains "Chrome" too, so Edge first.
  if (/Edg(?:e|A|iOS)?\//i.test(ua)) return "Edge";
  if (/OPR\/|Opera\//i.test(ua)) return "Opera";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/Chrome\//i.test(ua)) return "Chrome";
  // Safari fingerprint: "Safari/" present AND "Chrome/" absent (we've
  // already eliminated Chrome above so any remaining Safari is real).
  if (/Safari\//i.test(ua)) return "Safari";
  // Tauri webview reports as "Tauri/<ver>" on some platforms.
  if (/Tauri/i.test(ua)) return "Tauri";
  // curl / reqwest / generic HTTP clients — useful to distinguish
  // from a browser in the admin view.
  if (/^curl\//i.test(ua)) return "curl";
  if (/python-requests/i.test(ua)) return "python-requests";
  if (/reqwest/i.test(ua)) return "reqwest";
  return "unknown";
}

function detectOs(ua: string): string {
  // Order matters: iOS UAs literally contain "like Mac OS X", and
  // Android UAs contain "Linux" (the kernel). Match the more-specific
  // mobile platforms first so they win.
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows NT/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  if (/FreeBSD|OpenBSD|NetBSD/i.test(ua)) return "BSD";
  return "unknown";
}
