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
  /** Machine-readable error code from the backend (e.g. "email-taken"). */
  code: string;
  /** Human-readable message — backend supplies German strings already. */
  message: string;
};
export type ApiResult<T> = ApiOk<T> | ApiErr;

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
  } catch (e) {
    return {
      ok: false,
      status: 0,
      code: "network-error",
      message: `Netzwerkfehler: ${String(e)}`,
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
  // Backend error shape: { error: "code", message: "..." }
  const err = (body ?? {}) as { error?: unknown; message?: unknown };
  return {
    ok: false,
    status: res.status,
    code: typeof err.error === "string" ? err.error : "http-error",
    message:
      typeof err.message === "string" && err.message.length > 0
        ? err.message
        : `HTTP ${res.status}`,
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
 * The user types the code into the sharer's Settings → "Mit Account
 * verbinden" prompt; the sharer then POSTs /api/devices/redeem to
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

export function deleteDevice(id: string): Promise<ApiResult<{ ok: true }>> {
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

/**
 * Cursor-paginated connection log for a device. Pass `cursor` as the
 * `nextCursor` of the previous page; omit for page 1. `limit`
 * defaults to the backend's 20 and is clamped at `maxLimit`.
 */
export interface Me {
  id: number;
  email: string;
  emailVerifiedAt: number | null;
  createdAt: number;
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

export function deleteMe(body: DeleteMeBody): Promise<ApiResult<{ ok: true }>> {
  return request("/api/me", {
    method: "DELETE",
    body: JSON.stringify(body),
  });
}

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
