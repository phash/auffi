# Auffi Security Review — 2026-05-11

> **Historical note:** This review was conducted while the project was still
> named "Screenie". URLs and paths in the findings (`screenie.mr-development.de`,
> `~/Downloads/Screenie/`, `nginx/screenie-viewer.conf`, rate-limit zones
> `screenie_general`/`screenie_turn`) reflect the codebase at that point in
> time. Post-rebrand equivalents: domain `auffi.app`, downloads dir
> `~/Downloads/Auffi/`, nginx config `nginx/auffi-viewer.conf`, rate-limit
> zones `auffi_*`. The actual security findings remain accurate — only the
> identifiers have been renamed.

## Summary

**3 Critical, 7 Important, 9 Nits.** Overall risk: **medium** (no single critical issue allows full compromise in isolation, but two of the three critical issues compound).

The codebase is well-structured and implements most security controls correctly (DTLS-SRTP default, non-root Docker, redacted logs, origin checks on WebSocket, brute-force protection with sweep, file-name sanitization). The critical gaps are: a live TURN shared secret on disk that was checked out with the repo, an unauthenticated `/turn-credentials` endpoint reachable from any web origin, and a file opened on disk before the user confirms the transfer. Rust dependency chain carries 12 known CVEs (5 high severity) via the vendored `webrtc-rs` crate stack.

---

## Critical

### C-1 · Live TURN_SHARED_SECRET present in `.env.prod` on-disk

**Location:** `/home/manuel/claude/screenshare/.env.prod` (line 2)

**Severity:** Critical

**Evidence:**
```
TURN_SHARED_SECRET=432d8eeaed0c245fcf7c2a0bd9baa606518cec55c70639ac8663aaf3d1adbee4
```

The file is not committed to git (`.gitignore` is correct), but it sits unencrypted next to the source tree. Any developer machine or CI environment that has this working directory checked out, or any backup/snapshot that includes it, exposes the TURN shared secret. An attacker with the secret can forge arbitrary TURN credentials for the production relay and use the relay for unlimited bandwidth at the operator's cost (the coturn `user-quota=5000000` and `max-bps=5000000` per-user limits are still in effect, but there is no per-attacker limit once credentials are valid).

**Recommendation:** Rotate immediately using `./ops/maintenance.sh secret-rotate`. Store production secrets only in a secrets manager (Vault, SOPS, 1Password Secrets Automation) or in the CI/CD environment, never as a plain file in the working directory.

---

### C-2 · `/turn-credentials` endpoint has no CORS restriction — any web origin can obtain TURN credentials

**Location:** `backend/src/turn-credentials.ts` (entire file); `backend/src/server.ts` (lines 83, 131-137)

**Severity:** Critical

**Evidence:**
The WebSocket `verifyClient` enforces origin (server.ts:89-94), but `/turn-credentials` is a plain Fastify POST route with no CORS or origin header check. The rate limit is 10/min per IP (turn-credentials.ts:32), which is trivially bypassable from different IPs. Any web page can do:

```javascript
fetch("https://screenie.mr-development.de/turn-credentials", { method: "POST" })
  .then(r => r.json())
  .then(creds => /* TURN creds valid for 3600 s */);
```

Combined with C-1 (known shared secret), an attacker can forge their own credentials; without C-1 they can still harvest credentials at 10/min/IP. Credentials expire per the `username` epoch timestamp (TTL = 3600 s as advertised), but the window is wide. coturn's `lifetime=600` limits per-session allocation time, not credential freshness.

**Recommendation:** Add `@fastify/cors` restricted to `ALLOWED_ORIGINS` on the `/turn-credentials` endpoint, or restrict via Caddy. Additionally, require a `Referer` or a session token (e.g., require the signaling session code in the request body) so only active sessions can obtain credentials.

---

### C-3 · File created on disk before user confirms the transfer (sharer side)

**Location:** `sharer/src-tauri/src/files.rs` (lines 99-122); `sharer/src-tauri/src/lib.rs` (lines 256-264)

**Severity:** Critical

**Evidence:**
In `FileTransferManager::handle_offer()`, `open_output_file(&sanitized)` is called immediately when a `file-offer` event arrives over the DataChannel:

```rust
match Self::open_output_file(&sanitized) {
    Ok(file) => {
        let state = ReceiveState { ... };
        self.active.insert(id_hash, state);
        // THEN emit "file-offer" to webview for user confirmation
        app.emit("file-offer", payload)
    }
```

The file is created at `~/Downloads/Screenie/<sanitized_name>` unconditionally. The user confirmation dialog in `sharer/src/main.ts` (via `window.confirm`) fires only after the Tauri event is received — by which time the file descriptor is already open and the file exists on disk. An attacker-controlled viewer can:
1. Send a `file-offer` with a crafted name to create an arbitrary (empty) file in `~/Downloads/Screenie/`.
2. Immediately send chunks before the user dismisses the dialog, writing data to disk.
3. Send multiple concurrent offers to exhaust disk quota (no limit on concurrent active transfers).

Even with filename sanitization, creating an empty file (or writing up to 16 KB before the user blinks) is a side-effect that should require explicit acceptance first.

**Recommendation:** Reverse the order: emit the Tauri event and await the `accept_file` Tauri command before calling `open_output_file`. Only open the file and insert into `self.active` once the user has accepted.

---

## Important

### I-1 · `normalizeCode` has no length cap before regex (minor ReDoS surface)

**Location:** `backend/src/codes.ts` (lines 11-13)

**Severity:** Important

**Evidence:**
```typescript
export function normalizeCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  if (!/^\d{9}$/.test(digits)) return null;
```

`input` arrives as the `msg.code` field from JSON.parse of an arbitrary WebSocket message. A WebSocket payload can be up to `maxPayload: 65_536` bytes (server.ts:87). A 64 KB string is fed to `.replace(…)` first (allocates a new string), then to a simple anchor-fixed `/^\d{9}$/` test which is not itself a catastrophic backtracking pattern — but the allocation + replace pass on a 64 KB string is a non-trivial per-message cost in a tight loop. There is no explicit length check before the first operation.

In practice the regex does not backtrack catastrophically, so this is a DoS amplification risk rather than pure ReDoS, but it should be hardened.

**Recommendation:** Add `if (typeof input !== "string" || input.length > 20) return null;` as the first line of `normalizeCode`.

---

### I-2 · Viewer uses `stun:stun.l.google.com:19302` as default ICE fallback — third-party IP contact

**Location:** `viewer/src/webrtc-client.ts` (line 14)

**Severity:** Important

**Evidence:**
```typescript
const DEFAULT_ICE: IceServers = [{ urls: "stun:stun.l.google.com:19302" }];
```

This is used when `fetchIceServers` fails (network issue, no `TURN_SHARED_SECRET` set). On every WebRTC session start, the viewer's browser connects to Google's STUN server to discover the public IP — a third-party contact that reveals the user's IP to Google without consent. `CLAUDE.md` line 50 explicitly states "No third-party trackers in the viewer". STUN connections are not trackers per se, but they are third-party data disclosures.

**Recommendation:** Remove the Google STUN fallback from the viewer. If TURN credentials are unavailable, attempt a direct peer connection with no STUN (LAN use-case still works). Alternatively, add a self-hosted STUN server on the same domain and document it.

---

### I-3 · HMAC-SHA1 used for TURN credentials (algorithm strength)

**Location:** `backend/src/turn-credentials.ts` (line 19)

**Severity:** Important

**Evidence:**
```typescript
const credential = createHmac("sha1", cfg.sharedSecret).update(username).digest("base64");
```

HMAC-SHA1 is required by coturn's `use-auth-secret` mechanism (RFC 5389 long-term credential). The algorithm choice is not wrong for this use-case — coturn does not support SHA-256 for this mechanism. However, it should be explicitly documented that SHA-1 here is protocol-required, not a free design choice, so future auditors don't inadvertently "upgrade" to SHA-256 and break coturn compatibility.

**Recommendation:** Add a comment: `// coturn use-auth-secret requires HMAC-SHA1 per RFC 5766 §10.2 — SHA-256 is not supported`.

---

### I-4 · `uuid_v4()` for file transfer IDs uses weak entropy (PID × nanoseconds)

**Location:** `sharer/src-tauri/src/files.rs` (lines 366-384)

**Severity:** Important

**Evidence:**
```rust
fn uuid_v4() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let pid = std::process::id();
    let a = nanos ^ (pid << 16);
    let b = nanos.wrapping_mul(0x9e3779b9) ^ pid;
    // ...
}
```

The function is named `uuid_v4` but uses only `subsec_nanos` (0–999,999,999) XOR'd with a fixed PID. Subsecond nanoseconds is low-entropy (about 30 bits), PID is typically 2–5 digits. An attacker who knows the approximate send time (which they do, since they initiated the session) can enumerate the file UUID space and guess the `id_hash` used in the chunk header — allowing them to inject chunks into another active transfer. This is exploitable only when multiple file transfers are in flight simultaneously (unlikely in practice, but the design is fragile).

**Recommendation:** Use `rand::thread_rng().gen::<u128>()` or `uuid = { version = "1", features = ["v4"] }` with `Uuid::new_v4()`. Both use OS CSPRNG and avoid this issue entirely.

---

### I-5 · No limit on concurrent active file transfers (disk exhaustion / memory exhaustion)

**Location:** `sharer/src-tauri/src/files.rs` (`FileTransferManager::active` HashMap)

**Severity:** Important

**Evidence:**
A viewer can send repeated `file-offer` events without limits. Each creates a file on disk and an entry in `self.active` (unbounded `HashMap`). Out-of-order chunks accumulate in `BTreeMap<u32, Vec<u8>>` (also unbounded per transfer). A malicious viewer could:
- Create hundreds of files in `~/Downloads/Screenie/` exhausting inodes / disk space.
- Buffer millions of out-of-order chunks to exhaust heap.

The file is created before user confirmation (see C-3), so this attack surface is live before any user interaction.

**Recommendation:** After fixing C-3, apply the limits at the offer stage: (a) cap concurrent pending offers to e.g. 3; (b) cap total size (`offer.size`) against a configurable max (e.g. 2 GB); (c) bound `pending_chunks` per transfer to a maximum buffer size.

---

### I-6 · No HTTP security headers on viewer (no CSP, no X-Frame-Options, no HSTS preload)

**Location:** `caddy/Caddyfile`; `nginx/screenie-viewer.conf`

**Severity:** Important

**Evidence:**
Neither the Caddyfile nor the nginx config adds `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, or `Strict-Transport-Security` (Caddy's automatic HTTPS adds TLS but does not add HSTS). Caddy does auto-redirect HTTP→HTTPS but does not set `max-age` or `preload` for HSTS.

Although the viewer SPA uses `textContent` (not `innerHTML`) throughout `ui.ts` and has no obvious XSS vectors, the lack of a CSP means any future injection vulnerability or 3rd-party script (e.g., a supply-chain attack on npm) would have no sandbox.

**Recommendation:** Add to `caddy/Caddyfile`:
```
header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Frame-Options "DENY"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
    Content-Security-Policy "default-src 'self'; connect-src 'self' wss://screenie.mr-development.de; media-src blob:; worker-src 'none'; frame-ancestors 'none'"
}
```

---

### I-7 · `confirm_peer(accepted=false)` closes the WebSocket but does not close the signaling session atomically

**Location:** `backend/src/signaling.ts` (lines 115-123); `sharer/src-tauri/src/lib.rs` (`confirm_peer` command)

**Severity:** Important

**Evidence:**
When a sharer rejects:
```typescript
if (found.viewer) {
    send(viewerSocket, { type: "peer-rejected", reason: "declined" });
    viewerSocket.close();
}
store.removeBySharer(peer as Peer);
peer.close(); // sharer's WS closed
```

This is correct: viewer is notified, sharer WS is closed, session is removed. However, on the sharer Rust side, `confirm_peer(accepted=false)` only sends the `Confirm { accepted: false }` message — it does NOT nullify `SignalingState` or `WebRtcState`. If the viewer reconnects (new code assignment would need a new signaling session, but the Rust state now has a dead WS handle in `SignalingState`), `start_streaming` would fail with "signaling not started" rather than panicking. Low severity, but resource cleanup is incomplete.

**Recommendation:** After sending the decline, the sharer Rust side should also set `SignalingState.0 = None` (or equivalently, reset to a clean state) so `start_signaling` can be called again cleanly without restarting the app.

---

## Nits

### N-1 · `console.log` leaks host/port in production stdout

**Location:** `backend/src/index.ts` (line 8)

`console.log(\`Listening on ${host}:${port}\`)` bypasses Pino's redaction and emits a plain text line to stdout in all environments including production, potentially revealing the internal bind address. Replace with `app.log.info(…)`.

---

### N-2 · `sanitize_filename` does not block Windows reserved names

**Location:** `sharer/src-tauri/src/files.rs` (`sanitize_filename` function, documented spec)

On the current Linux target this is not exploitable. However, if a Windows build is ever shipped, names like `CON`, `NUL`, `COM1`, `PRN`, `AUX`, `LPT1`–`LPT9` are reserved and `std::fs::File::create("NUL")` on Windows writes to the null device. Consider adding a Windows reserved-name blocklist (case-insensitive, strip extension before check).

---

### N-3 · `ops/lib.sh` uses `StrictHostKeyChecking=accept-new` (TOFU)

**Location:** `ops/lib.sh` (line 46)

TOFU (trust-on-first-use) means if the first connection is to a MITM server, the bogus key is silently accepted. Should use `StrictHostKeyChecking=yes` with the VPS fingerprint pinned in `~/.ssh/known_hosts` on the CI/build machine.

---

### N-4 · coturn is in `verbose` mode, logs client IPs to stdout

**Location:** `coturn/turnserver.conf.tmpl` (line 20)

coturn `verbose` mode logs UDP/TCP session events including client IPs. Under DSGVO this is PII. Consider `no-stdout-log` or piping logs through a filter that truncates IPs (similar to backend Pino redaction) before they reach persistent storage.

---

### N-5 · Relay payload forwarded without schema validation

**Location:** `backend/src/signaling.ts` (lines 127-133)

```typescript
if (msg.type === "relay") {
    const found = store.findByPeer(peer as Peer);
    if (!found) return;
    if (!found.confirmed) return;
    const target = role === "sharer" ? found.viewer : found.sharer;
    if (target) send(target as WebSocket, { type: "relay", payload: msg.payload });
```

The relay `payload` is forwarded verbatim to the other peer without schema validation. Any JSON value (including very deeply nested objects) can be relayed. The 65 KB `maxPayload` on the WebSocket caps the total message size. The receiver (viewer browser or Rust `serde_json::Value`) both safely deserialize unknown content, so this is not directly exploitable. However, adding a JSON schema check (SDP/ICE/hello only) would harden the signaling channel against protocol confusion attacks.

---

### N-6 · `ops/.env.deploy` exists with real SSH target on disk (not in git, but on developer machine)

**Location:** `/home/manuel/claude/screenshare/ops/.env.deploy`

Contains `DEPLOY_SSH=musikersuche@musikersuche.org` and `DEPLOY_PATH=/opt/screenie`. This file is gitignored but exists on the review machine, so it would be included in a naive backup. Ensure team members understand that this file must not be committed or stored in unauthenticated cloud storage.

---

### N-7 · `find_session` (via `getSession`) is not constant-time — timing oracle for code enumeration

**Location:** `backend/src/codes.ts` (`getSession` → `sessions.get(code)`)

JavaScript `Map.get` is effectively O(1) with a constant-time hash lookup, but the response time difference between "code exists and is valid" vs "code does not exist" is measurable over many samples because `getSession` additionally checks `expiresAt`. The rate-limit (5 attempts/IP/minute) and 10-min TTL on ad-hoc codes make this impractical to exploit (note: the 5-attempt lockout is a password-surface mechanism for account login and per-device unattended access, not the ad-hoc code path). Document the explicit design decision so future changes don't inadvertently remove those protections while assuming timing is safe.

---

### N-8 · `HSTS` header not configured in Caddy

**Location:** `caddy/Caddyfile`

Caddy auto-provisions TLS and redirects HTTP→HTTPS, but does not add `Strict-Transport-Security`. Without it, browsers will not preload HTTPS-only for the domain, allowing a network attacker on first visit to intercept the HTTP redirect. Also covered in I-6; listing separately because it's trivial to add.

---

### N-9 · `webrtc_peer.rs` `on_ice_candidate` callback uses `std::sync::Mutex` inside async context

**Location:** `sharer/src-tauri/src/webrtc_peer.rs` (lines 154-163)

```rust
let handler = Arc::new(Mutex::new(handler));
self.pc.on_ice_candidate(Box::new(move |candidate| {
    let handler = handler.clone();
    Box::pin(async move {
        if let Ok(mut h) = handler.lock() {
            h(candidate);
```

`std::sync::Mutex::lock` in an async context can block the executor thread if the lock is contended. Use `tokio::sync::Mutex` or restructure to not lock across await points.

---

## Dependency Audit

### npm audit (all packages)

All four npm packages (`backend`, `viewer`, `scripts`, `sharer`) report **0 vulnerabilities** across 410 total dependencies. No action needed.

### cargo audit (`sharer/src-tauri`)

**12 vulnerabilities found, 21 warnings.**

#### High/Critical CVEs (action required)

| Crate | Version | ID | Severity | Title | Solution |
|-------|---------|-----|----------|-------|---------|
| `aws-lc-sys` | 0.30.0 | RUSTSEC-2026-0046 | 7.5 | PKCS7_verify Certificate Chain Validation Bypass | ≥0.38.0 |
| `aws-lc-sys` | 0.30.0 | RUSTSEC-2026-0047 | 7.5 | PKCS7_verify Signature Validation Bypass | ≥0.38.0 |
| `aws-lc-sys` | 0.30.0 | RUSTSEC-2026-0048 | 7.4 | CRL Distribution Point Scope Check Logic Error | ≥0.39.0 |
| `rustls` | 0.19.1 | RUSTSEC-2024-0336 | 7.5 | `complete_io` infinite loop on network input | ≥0.21.11 |
| `webpki` | 0.21.4 | RUSTSEC-2023-0052 | 7.5 | CPU DoS in certificate path building | ≥0.22.2 |

All five are transitive dependencies of `webrtc = 0.8.0` (via `webrtc-dtls 0.7.2`). The `rustls 0.19.1` infinite-loop DoS is particularly relevant because `webrtc-dtls` uses it for DTLS handshake — a malicious peer could potentially trigger the loop during ICE negotiation.

#### Medium CVEs

| Crate | Version | ID | Severity | Title |
|-------|---------|-----|----------|-------|
| `aws-lc-sys` | 0.30.0 | RUSTSEC-2026-0045 | 5.9 | AES-CCM Timing Side-Channel |
| `curve25519-dalek` | 3.2.0 | RUSTSEC-2024-0344 | — | Timing variability in Scalar sub |
| `ring` | 0.16.20 | RUSTSEC-2025-0009 | — | AES panic with overflow-checks |
| `rustls-webpki` | 0.103.4 | RUSTSEC-2026-0049 | — | CRL faulty matching logic |
| `rustls-webpki` | 0.103.4 | RUSTSEC-2026-0098 | — | Name constraints URI bypass |
| `rustls-webpki` | 0.103.4 | RUSTSEC-2026-0099 | — | Wildcard name constraint bypass |
| `rustls-webpki` | 0.103.4 | RUSTSEC-2026-0104 | — | Reachable panic in CRL parsing |

#### Root cause

All crypto CVEs trace to `webrtc = "=0.8.0"` pulling in `webrtc-dtls 0.7.2` which vendors old versions of `rustls (0.19.1)`, `webpki (0.21.4)`, `ring (0.16.20)`, and `curve25519-dalek (3.2.0)`. The `aws-lc-sys` CVEs come from `reqwest 0.13.3 → aws-lc-rs 1.13.3 → aws-lc-sys 0.30.0`.

**Decision taken (2026-05-12):** Keep `webrtc = "=0.8.0"` and accept the transitive CVE chain as a known residual risk. See section below.

---

### Residual Risk: rustls CVE chain via webrtc-dtls — Known, Accepted (2026-05-12)

**Affected crates (all transitive via `webrtc = "=0.8.0"`):**

| Crate | Version | RUSTSEC | Severity | Title |
|-------|---------|---------|----------|-------|
| `rustls` | 0.19.1 | RUSTSEC-2024-0336 | 7.5 | `complete_io` infinite loop on network input |
| `webpki` | 0.21.4 | RUSTSEC-2023-0052 | 7.5 | CPU DoS in certificate path building |
| `aws-lc-sys` | 0.30.0 | RUSTSEC-2026-0045/46/47/48 | 5.9–7.5 | AES-CCM side-channel, PKCS7 bypass, CRL scope |
| `curve25519-dalek` | 3.2.0 | RUSTSEC-2024-0344 | — | Timing variability in Scalar sub |
| `ring` | 0.16.20 | RUSTSEC-2025-0009 | — | AES panic with overflow-checks |
| `rustls-webpki` | 0.103.4 | RUSTSEC-2026-0049/98/99/104 | — | CRL/name-constraint parsing issues |

**Why the risk is accepted for now:**

- `webrtc = "=0.8.0"` pins an exact version because its API is tightly coupled to our `webrtc_peer.rs` implementation. All higher-level `webrtc-rs` releases (`0.9+`) contain breaking API changes in `PeerConnection`, ICE candidate handling, and the `MediaEngine`.
- The `rustls 0.19.1` DoS (RUSTSEC-2024-0336 — `complete_io` infinite loop) requires an attacker with network position to send a crafted DTLS record during the DTLS handshake. The DTLS handshake is already inside an ICE-authenticated pair; unauthenticated attackers cannot reach it. Risk is elevated from theoretical to limited-attacker.
- `[patch.crates-io]` to override `rustls 0.19 → 0.21+` is not feasible: `webrtc-dtls 0.7.2` calls `rustls::internal::msgs` private APIs that were removed in 0.20. Compilation fails.
- `aws-lc-sys` CVEs (PKCS7 validation bypass) are not reachable from our code path; we do not call PKCS7 verification APIs.

**Migration path (tracked, not blocked):**

1. **Short term:** Monitor `webrtc-rs` upstream for a `0.9+` release or an official CVE fix backport.
2. **Medium term:** Evaluate migrating to [`str0m`](https://github.com/algesten/str0m) (actively maintained pure-Rust WebRTC, no old rustls vendoring). API is different; migration estimate is ~2–4 days of work.
3. **Long term:** If `str0m` proves too large an API change, consider `libdatachannel` Rust bindings which link against a C++ WebRTC stack with its own patch cadence.

**Monitoring:** Re-run `cargo audit` on every PR and before each production deployment. If RUSTSEC-2024-0336 severity is upgraded to critical or a PoC exploit appears, accelerate the `str0m` migration.

---

## Threat-Model Coverage Assessment

| Planned Control | Status |
|-----------------|--------|
| DTLS-SRTP enforced (no plain-RTP path) | ✅ Implemented — `register_default_interceptors` + `MediaEngine::register_default_codecs` default to DTLS-SRTP; no insecure flags found |
| Origin check on WebSocket upgrade | ✅ Implemented — `verifyClient` in `websocketPlugin` options, blocks unknown origins with 403 |
| Code brute-force protection (ad-hoc) | ✅ Per-IP rate-limit (5/min) + 10-min TTL cap + mandatory sharer confirmation. The former ad-hoc code-burn (`recordFailedAttempt` / `maxAttempts`) was removed — it never fired (invoked only on the unknown-code branch, where it is a no-op). The separate 5-attempt password lockout (`account_lockout.ts`, per-device unattended) is a different mechanism and is unaffected |
| Rate-limit per-IP for join attempts | ✅ Implemented — `checkRateLimit` + periodic sweep in `server.ts` |
| Rate-limit map memory bounded (periodic sweep) | ✅ Implemented — `setInterval(60_000)` sweep in `server.ts:108-113` |
| Session TTL enforced server-side | ✅ Implemented — `getSession` checks `expiresAt` on every lookup |
| Sharer confirmation mandatory | ✅ Implemented — `relay` messages gate on `found.confirmed`; viewer WS closed on decline |
| Non-root container | ✅ Implemented — Dockerfile creates `app` user, `USER app` |
| No secrets in Docker image | ✅ Implemented — `env_file` at runtime only, no secrets in COPY layers |
| Health check in container | ✅ Implemented — `HEALTHCHECK` in Dockerfile and docker-compose |
| PII redaction in logs | ✅ Implemented — Pino `redact` config removes IPs, cookies, auth headers |
| IP truncation to prefix | ✅ Implemented — `ipPrefix()` in signaling.ts returns `84.xxx` style |
| TURN credentials ephemeral (HMAC, ≤1 h TTL) | ✅ Implemented — `makeCredentials` with `expiresAt + randomUUID` |
| TURN secret rotation tooling | ✅ Implemented — `./ops/maintenance.sh secret-rotate` |
| No third-party trackers/CDN in viewer | ✅ Resolved — Google STUN fallback removed (I-2, 2026-05-12) |
| Filename sanitization against path traversal | ✅ Implemented — strips `..`, `/`, `\`, control chars, truncates to 255 bytes |
| Windows reserved names in sanitize_filename | ⚠️ Not implemented (nit N-2 — Linux-only for now) |
| File transfer requires user confirmation | ✅ Resolved — file opened only after accept_file command (C-3, 2026-05-12) |
| Origin check on `/turn-credentials` | ✅ Resolved — @fastify/cors + origin check in handler (C-2, 2026-05-12) |
| CORS / security headers on viewer | ✅ Resolved — CSP + HSTS added to Caddy (I-6, N-8, 2026-05-12) |
| Bounded out-of-order chunk buffer | ⚠️ Partial — `BTreeMap` still unbounded per transfer; MAX_CONCURRENT_TRANSFERS=5 cap added (I-5) |
| Concurrent transfer limit | ✅ Resolved — MAX_CONCURRENT_TRANSFERS=5 across pending+active (I-5, 2026-05-12) |
| CSPRNG for file transfer UUIDs | ✅ Resolved — uuid::Uuid::new_v4() with OS CSPRNG (I-4, 2026-05-12) |
| Bot UA filtering at reverse proxy | ✅ Resolved — @scrapers matcher in Caddy, /healthz+/readyz excluded (2026-05-12) |
| Per-IP rate limiting on screenie site | ✅ Resolved — screenie_general 300/min, screenie_turn 10/min in Caddy (2026-05-12) |
| Per-peer WebSocket message rate limit | ✅ Resolved — 50 msg/10 s per connection, close on exceed (2026-05-12) |
| coturn TLS cipher hardening | ✅ Resolved — explicit cipher-list with TLS 1.3 AEADs + ECDHE-AEAD for 1.2 (2026-05-12) |
| rustls CVE chain (webrtc transitive deps) | ⚠️ Known, accepted — see "Residual Risk" section above; migration path documented |
| TLS 1.1 disabled on edge | ✅ Verified — openssl s_client -tls1_1 rejected; TLS 1.2+1.3 with AEAD only |

---

## Recommendations Summary (Priority Order)

1. **[Critical] Rotate `TURN_SHARED_SECRET` immediately** (C-1). The current value `432d8eea…` is exposed on developer disk. Run `./ops/maintenance.sh secret-rotate` against production now. Store the new secret in a proper secrets manager.

2. **[Critical] Restrict `/turn-credentials` to allowed origins** (C-2). Add `@fastify/cors` with `ALLOWED_ORIGINS` or enforce via Caddy `header` directive. Optionally require a short-lived token tied to an active signaling session.

3. **[Critical] Reverse file creation order — open file only after user accepts** (C-3). Emit the `file-offer` Tauri event and await `accept_file` command before calling `open_output_file`. Only then insert into `self.active`.

4. **[Important] Upgrade `reqwest` and resolve `webrtc` CVE chain** (Dep section). The `rustls 0.19.1` infinite-loop DoS (RUSTSEC-2024-0336) is the highest-risk active vuln. Apply `[patch.crates-io]` immediately; plan webrtc crate migration.

5. **[Important] Add security headers to Caddy** (I-6, N-8). CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`.

6. **[Important] Replace `uuid_v4()` with CSPRNG** (I-4). Use `rand::thread_rng().gen::<u128>()` or the `uuid` crate with v4 feature.

7. **[Important] Add length guard to `normalizeCode`** (I-1). `if (typeof input !== "string" || input.length > 20) return null;` before any regex.

8. **[Important] Remove Google STUN fallback from viewer** (I-2). Use own STUN endpoint or omit fallback.

9. **[Important] Bound file transfer pending buffer and concurrent transfers** (I-5). Cap `active.len()` at 5, reject further offers; cap `pending_chunks` total size at configurable max.

10. **[Important] Clean up Rust state on `confirm_peer(false)`** (I-7). Set `SignalingState.0 = None` after decline.

11. **[Nit] Replace `console.log` with Pino logger in `index.ts`** (N-1).

12. **[Nit] Add Windows reserved name check to `sanitize_filename`** (N-2) — low urgency given Linux-only deployment, but needed before any Windows release.

13. **[Nit] Pin SSH `known_hosts` on CI** (N-3). Use `StrictHostKeyChecking=yes` instead of `accept-new`.

14. **[Nit] Disable coturn `verbose` logging or filter IPs** (N-4). DSGVO compliance.

---

*Review performed 2026-05-11 against commit `9a30b39` (HEAD). All source files read directly from `/home/manuel/claude/screenshare/`.*
