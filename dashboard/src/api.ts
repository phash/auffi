// Thin fetch wrapper for the backend /api/* surface.
//
// All requests include credentials so the __Host-auffi_session cookie is
// sent on every authed call. The base URL defaults to "" (same-
// origin, the production layout where Caddy serves /dashboard/*
// and /api/* on auffi.app) and can be overridden via the Vite env
// var `VITE_API_BASE` for local dev where the dashboard lives on
// :5174 and the backend on :8080.
//
// Result shape is a tagged union so callers handle errors as data,
// not exceptions. Network failures (DNS, CORS, offline) collapse
// into `ok: false, status: 0` so the UI can show a uniform
// "Backend nicht erreichbar" message.

export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = {
  ok: false;
  status: number;
  /**
   * Machine-readable error code from the backend (e.g. "email-taken").
   * This is what the UI maps to German copy; a 429 from @fastify/rate-limit
   * is normalised to "rate-limit" here because the plugin's default body
   * carries error:"Too Many Requests".
   */
  code: string;
  /**
   * Human-readable message. Backend `bad()` messages are English
   * diagnostics — views map `code` to German copy and only fall back to
   * this for codes they do not know. Network errors and 429s already carry
   * German copy from `request()`.
   */
  message: string;
  /** Seconds until a 423 "locked" gate opens again (Sec H-3). */
  retryAfterSec?: number;
};
export type ApiResult<T> = ApiOk<T> | ApiErr;

const RATE_LIMIT_MESSAGE = "Zu viele Versuche. Bitte später erneut versuchen.";

export interface ApiClient {
  base: string;
  /** Override for tests / SSR (jsdom defaults to global.fetch). */
  fetch: typeof fetch;
}

let _client: ApiClient | null = null;

export function getApiClient(): ApiClient {
  if (_client) return _client;
  // Vite injects import.meta.env at build time.
  const base =
    (import.meta.env?.VITE_API_BASE as string | undefined) ?? "";
  _client = { base, fetch: globalThis.fetch.bind(globalThis) };
  return _client;
}

/** Test seam — swap the client wholesale (e.g. to inject a fake
 *  fetch). Reset back to null between tests to fall through to the
 *  env-driven default. */
export function _setApiClientForTests(client: ApiClient | null): void {
  _client = client;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  const client = getApiClient();
  const url = client.base + path;
  let res: Response;
  try {
    res = await client.fetch(url, {
      ...init,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    return {
      ok: false,
      status: 0,
      code: "network-error",
      // Fixed, friendly copy — never interpolate the raw exception (it's
      // not German, not actionable, and can be noisy in the UI).
      message: "Netzwerkfehler — bitte die Internetverbindung prüfen und erneut versuchen.",
    };
  }
  // The backend's 2xx responses are JSON. 4xx error bodies are
  // also JSON shaped { error, message }. Parse defensively — a
  // server-side exception might return text/html.
  let body: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (res.ok) {
    return { ok: true, data: (body as T) ?? (undefined as unknown as T) };
  }
  // Every per-route cap uses @fastify/rate-limit's default response, whose
  // body is { error: "Too Many Requests", message: "Rate limit exceeded,
  // retry in …" } — normalise by status so views see one code and German copy.
  if (res.status === 429) {
    return { ok: false, status: 429, code: "rate-limit", message: RATE_LIMIT_MESSAGE };
  }
  // Backend error shape: { error: "code", message: "...", retryAfterSec? }
  const err = (body ?? {}) as { error?: unknown; message?: unknown; retryAfterSec?: unknown };
  return {
    ok: false,
    status: res.status,
    code: typeof err.error === "string" ? err.error : "http-error",
    message:
      typeof err.message === "string" && err.message.length > 0
        ? err.message
        : `HTTP ${res.status}`,
    ...(typeof err.retryAfterSec === "number" ? { retryAfterSec: err.retryAfterSec } : {}),
  };
}

// ── Auth endpoints ─────────────────────────────────────────────────

export function signup(email: string, password: string): Promise<ApiResult<{ ok: true }>> {
  return request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function login(email: string, password: string): Promise<ApiResult<{ ok: true }>> {
  return request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function logout(): Promise<ApiResult<{ ok: true }>> {
  return request("/api/auth/logout", { method: "POST" });
}

/**
 * Backend exposes verify as GET so the mail-client click works
 * without form submission. We honour that here.
 */
export function verifyEmail(token: string): Promise<ApiResult<{ ok: true }>> {
  return request(`/api/auth/verify/${encodeURIComponent(token)}`, {
    method: "GET",
  });
}

/**
 * Confirms a pending email change. GET for the same reason verifyEmail is:
 * the user arrives by clicking a link in a mail client. The backend performs
 * the swap and clears the session cookie on the same response.
 */
export function confirmEmailChange(token: string): Promise<ApiResult<{ ok: true }>> {
  return request(`/api/me/email-change/${encodeURIComponent(token)}`, {
    method: "GET",
  });
}

/**
 * Initiates a password-reset flow. Backend ALWAYS returns 200 — we
 * cannot let the response distinguish "email exists" from "email
 * unknown" (would enable enumeration). The caller therefore shows a
 * generic "if the address is on file, a mail is on its way".
 */
export function forgotPassword(email: string): Promise<ApiResult<{ ok: true }>> {
  return request("/api/auth/forgot", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export function resetPassword(
  token: string,
  password: string,
): Promise<ApiResult<{ ok: true }>> {
  return request(`/api/auth/reset/${encodeURIComponent(token)}`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

// ── Device endpoints ───────────────────────────────────────────────

export interface Device {
  id: string;
  alias: string;
  autoAccept: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  online: boolean;
}

export function listDevices(): Promise<ApiResult<{ items: Device[] }>> {
  return request("/api/devices", { method: "GET" });
}

export interface PairingCodeResponse {
  code: string;
  expiresAt: number;
}

/**
 * Mint a fresh single-use pairing code for the signed-in account.
 * The user types the code into the sharer's Einstellungen →
 * "Unattended-Modus" → "Pairing-Code vom Dashboard" field (the label
 * add-device.ts quotes); the sharer then POSTs /api/devices/redeem to
 * trade it for a permanent token (spec §5.1 + §5.2).
 */
export function mintPairingCode(): Promise<ApiResult<PairingCodeResponse>> {
  return request("/api/devices/pairing-code", { method: "POST" });
}

export interface DevicePatch {
  alias?: string;
  auto_accept?: boolean;
}

export function patchDevice(
  id: string,
  patch: DevicePatch,
): Promise<ApiResult<{ ok: true }>> {
  return request(`/api/devices/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** Backend answers 204 with no body — there is no `data` to read. */
export function deleteDevice(id: string): Promise<ApiResult<void>> {
  return request(`/api/devices/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export interface ConnectionLogRow {
  id: number;
  deviceId: string;
  startedAt: number;
  endedAt: number | null;
  viewerIpPrefix: string;
  connectionType: "p2p" | "relay";
  bytesRelayed: number;
}

export interface ConnectionLogPage {
  items: ConnectionLogRow[];
  nextCursor: number | null;
  maxLimit: number;
}

export interface Me {
  id: number;
  email: string;
  emailVerifiedAt: number | null;
  createdAt: number;
  /**
   * Whether the authenticated account has admin privileges. Used by the
   * dashboard nav-gate (#53) to decide whether to show admin links and
   * by router.ts to gate /admin/* routes — backend still enforces with
   * requireAdmin on every admin endpoint, this flag is UX-only.
   */
  admin: boolean;
  pendingEmail: string | null;
  pendingEmailExpiresAt: number | null;
}

export function getMe(): Promise<ApiResult<Me>> {
  return request("/api/me", { method: "GET" });
}

export interface PatchMeBody {
  current_password: string;
  new_email?: string;
  new_password?: string;
}

export function patchMe(body: PatchMeBody): Promise<ApiResult<{ ok: true }>> {
  return request("/api/me", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export interface DeleteMeBody {
  current_password: string;
  /** Must be the exact string "LÖSCHEN" per backend acceptance. */
  confirm: string;
}

/** Backend answers 204 with no body. */
export function deleteMe(body: DeleteMeBody): Promise<ApiResult<void>> {
  return request("/api/me", {
    method: "DELETE",
    body: JSON.stringify(body),
  });
}

/**
 * Cursor-paginated connection log for a device. Pass `cursor` as the
 * `nextCursor` of the previous page; omit for page 1. `limit`
 * defaults to the backend's 20 and is clamped at `maxLimit`.
 */
export function listConnectionLog(
  deviceId: string,
  cursor?: number,
  limit?: number,
): Promise<ApiResult<ConnectionLogPage>> {
  const qs = new URLSearchParams();
  if (cursor !== undefined) qs.set("cursor", String(cursor));
  if (limit !== undefined) qs.set("limit", String(limit));
  const path =
    `/api/devices/${encodeURIComponent(deviceId)}/log` +
    (qs.toString().length > 0 ? `?${qs}` : "");
  return request(path, { method: "GET" });
}

// ── Feedback (gh #39) ─────────────────────────────────────────────

export type FeedbackCategory = "bug" | "feature" | "praise" | "other";
export type FeedbackSource = "dashboard" | "sharer" | "viewer";

export interface FeedbackSubmission {
  source: FeedbackSource;
  category: FeedbackCategory;
  rating: number;
  body: string;
}

export function submitFeedback(
  payload: FeedbackSubmission,
): Promise<ApiResult<{ ok: true }>> {
  return request("/api/feedback", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ── Admin feedback (gh #39) ───────────────────────────────────────

export interface AdminFeedbackRow {
  id: number;
  accountId: number;
  accountEmail: string;
  source: FeedbackSource;
  category: FeedbackCategory;
  rating: number;
  body: string;
  userAgentHint: string | null;
  createdAt: number;
  resolvedAt: number | null;
  replyBody: string | null;
  repliedAt: number | null;
  repliedBy: number | null;
  replySentAt: number | null;
}

export interface AdminFeedbackPage {
  items: AdminFeedbackRow[];
  nextCursor: number | null;
}

export function listAdminFeedback(opts: {
  status?: "open" | "resolved" | "all";
  cursor?: number;
  limit?: number;
} = {}): Promise<ApiResult<AdminFeedbackPage>> {
  const qs = new URLSearchParams();
  qs.set("status", opts.status ?? "open");
  if (opts.cursor !== undefined) qs.set("cursor", String(opts.cursor));
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  return request(`/api/admin/feedback?${qs}`, { method: "GET" });
}

export function patchAdminFeedback(
  id: number,
  resolved: boolean,
): Promise<ApiResult<{ ok: true; resolvedAt: number | null }>> {
  return request(`/api/admin/feedback/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ resolved }),
  });
}

/** Backend answers 204 with no body. */
export function deleteAdminFeedback(id: number): Promise<ApiResult<void>> {
  return request(`/api/admin/feedback/${id}`, { method: "DELETE" });
}

/**
 * Reply to a feedback row. The backend persists the reply (so a SMTP
 * outage doesn't lose the typed text) and tries to send the email; the
 * response reports both `replyAt` (always set on 200) and `sentAt`
 * (null if SMTP failed — see `sendError`).
 */
export function replyAdminFeedback(
  id: number,
  reply: string,
): Promise<
  ApiResult<{ ok: true; replyAt: number; sentAt: number | null; sendError?: string }>
> {
  return request(`/api/admin/feedback/${id}/reply`, {
    method: "POST",
    body: JSON.stringify({ reply }),
  });
}

// ── Admin Stats ─────────────────────────────────────────────────────
// Spiegelt das Server-Schema aus backend/src/admin/stats.ts. Wenn das
// Backend-Schema sich ändert, BEIDE Stellen synchron halten — der
// `import type` aus dem Backend würde die backend→dashboard-Grenze
// brechen, deshalb hier dupliziert (so wie alle anderen API-Typen
// im File).

export interface AdminStats {
  users: {
    total: number;
    verified: number;
    suspended: number;
    active_24h: number;
    active_7d: number;
    active_30d: number;
    new_24h: number;
    new_7d: number;
  };
  devices: {
    total: number;
    online_now: number;
    paired_24h: number;
  };
  connections: {
    today: number;
    week: number;
    p2p_today: number;
    relay_today: number;
    relay_bytes_today: number;
  };
  system: {
    db_size_bytes: number;
    uptime_seconds: number;
  };
}

export interface AdminCodeStats {
  total: number;
  last24h: number;
  last7d: number;
  last30d: number;
  perDay: Array<{ day: string; count: number }>;
}

export function fetchAdminStats(): Promise<ApiResult<AdminStats>> {
  return request("/api/admin/stats", { method: "GET" });
}

export function fetchAdminCodeStats(): Promise<ApiResult<AdminCodeStats>> {
  return request("/api/admin/stats/codes", { method: "GET" });
}

// ── Admin Users ─────────────────────────────────────────────────────
// Backend in backend/src/admin/users.ts — keep both in sync. Status
// filter chips correspond to the four `status=`-query values plus the
// "alle"-default (no `status` param).

export type AdminUserStatus = "active" | "suspended" | "unverified" | "admin";

export interface AdminUserListItem {
  id: number;
  email: string;
  admin: boolean;
  suspended_at: number | null;
  email_verified_at: number | null;
  created_at: number;
  device_count: number;
  last_login_at: number | null;
}

export interface AdminUserListPage {
  items: AdminUserListItem[];
  next_cursor: string | null;
}

export function listAdminUsers(opts: {
  status?: AdminUserStatus;
  q?: string;
  cursor?: string;
  limit?: number;
} = {}): Promise<ApiResult<AdminUserListPage>> {
  const qs = new URLSearchParams();
  if (opts.status) qs.set("status", opts.status);
  if (opts.q && opts.q.trim()) qs.set("q", opts.q.trim());
  if (opts.cursor) qs.set("cursor", opts.cursor);
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  const suffix = qs.toString();
  return request(`/api/admin/users${suffix ? `?${suffix}` : ""}`, { method: "GET" });
}

export interface AdminUserDevice {
  id: string;
  alias: string;
  last_seen_at: number | null;
  online: boolean;
}

export interface AdminUserConnection {
  id: number;
  device_id: string;
  started_at: number;
  ended_at: number | null;
  connection_type: string;
  bytes_relayed: number;
}

export interface AdminUserAudit {
  id: number;
  admin_id: number;
  action: string;
  created_at: number;
  before_json: string | null;
  after_json: string | null;
}

export interface AdminUserDetail {
  id: number;
  email: string;
  admin: boolean;
  suspended_at: number | null;
  email_verified_at: number | null;
  created_at: number;
  devices: AdminUserDevice[];
  recent_connections: AdminUserConnection[];
  recent_audits: AdminUserAudit[];
}

export function getAdminUser(id: number): Promise<ApiResult<AdminUserDetail>> {
  return request(`/api/admin/users/${id}`, { method: "GET" });
}

export type AdminUserAction = "suspend" | "unsuspend" | "promote" | "demote";

export function patchAdminUser(
  id: number,
  action: AdminUserAction,
  reason: string,
): Promise<ApiResult<{ ok: true }>> {
  return request(`/api/admin/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ action, reason }),
  });
}

/** Backend answers 204 with no body. */
export function deleteAdminUser(
  id: number,
  reason: string,
): Promise<ApiResult<void>> {
  return request(`/api/admin/users/${id}`, {
    method: "DELETE",
    body: JSON.stringify({ reason }),
  });
}
