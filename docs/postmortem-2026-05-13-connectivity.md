# Postmortem — Connectivity Chain, 2026-05-13

## Context

After the 2026-05-12 monitor-switch chain settled, the user hit a different class of bugs: the connection wouldn't come up at all, or came up but routed every byte through the prod VPS in Frankfurt even when both peers sat on the same NAT. Five layers, each masking the next.

This day was about the **network plane** (zbus runtimes, IP binding, firewalls, ICE candidate types, input event rate), not the session-state plane the previous postmortem was about.

## The five layers

| # | Symptom | Root cause | Fix |
|---|---------|------------|-----|
| 1 | Second portal dialog never appeared after `switch_monitor` — sharer hung at `[gst-portal] open_portal start` without ever logging `session created`. | `ashpd 0.10` caches a single `zbus::Connection` in a `static OnceLock`. `GstPortalCapturer::start` was spawning a fresh OS thread + fresh single-threaded tokio runtime for each portal handshake. The cached connection was bound to the first runtime, which died after the first session returned. The second portal call reused the cached connection, whose zbus dispatch tasks were on the dead runtime — `create_session()` had no one to wake it. | Drive the portal handshake on the caller's long-lived runtime (Tauri's `async_runtime`). `ScreenCapturer::start` became `async`; X11/Windows arms wrapped in `spawn_blocking`. Commit `be86d3f`. |
| 2 | New session reported `ice_servers count=2` but produced zero `srflx`/`relay` candidates — only ~25 raw private IPs (every Docker bridge). Direct UDP/TCP probes to `turn.auffi.app:3478/5349` from outside the prod host timed out. | coturn's interface auto-detection on the IONOS VPS skipped the public IPv4 (`82.165.40.140`) — even though it was `/32`-bound to `ens6`. coturn listened on a handful of Docker bridges and IPv6 only. The TURN server existed but wasn't reachable. | Add `listening-ip` and `external-ip` env-driven config knobs to `coturn/turnserver.conf.tmpl`; set both to the public IPv4 in `.env.prod`. Commit `f37ef22`. |
| 3 | Even after coturn was bound to the public IP, probes from outside still timed out silently. | UFW on the prod host allowed only 22/80/443 by default. TURN/STUN ports were dropped at the perimeter. | Open UDP+TCP `3478`/`5349` and UDP `49152-65535` in UFW. Done by hand on the host, not in the repo (UFW state is host-local). |
| 4 | TURN reachable + `[turn-fetch]` shows credentials + ICE candidates of all types — but `[ice-connected] type=relay` even when both peers sit on the same NAT (same `srflx` IP `88.xxx.xxx.xxx`). Every video frame round-trips through Frankfurt. The user reported "ist schon recht lahm". | webrtc-rs default `MulticastDnsMode::QueryOnly`: sharer publishes its raw host candidates (private LAN IPs + every Docker bridge), Chrome publishes only mDNS-anonymized `.local` hostnames. No candidate pair survived its connect-check. ICE settled on the only working pair: relay through `82.165.40.140`. | Switch sharer to `MulticastDnsMode::QueryAndGather` so it ALSO publishes `.local` mDNS candidates. Avahi (already running on the user's host) bridges both sides on the LAN. P2P direct works on shared LAN; TURN remains the fallback for split-network cases. Commit `2ada78c`. Bonus: stops leaking the host's full LAN/Docker-bridge IP list in SDP. |
| 5 | Mouse cursor visibly laggy even on direct-p2p. Other input (clicks, keys, scroll) felt fine. | `onMove` in `viewer/src/input-capture.ts` emitted unconditionally on every `pointermove`. A 1000 Hz gaming mouse flooded the unreliable input DataChannel with JSON messages; SCTP serializes, sharer's enigo apply-loop became the bottleneck. | `requestAnimationFrame`-throttle: coalesce moves to one emit per frame (~60 Hz), always the latest x/y. Buttons/keys/wheel stay immediate. 16× message-rate reduction for 1000 Hz mice. Commit `26edea0`. |

## Recurring patterns

**Cached static + per-call runtimes is a footgun.** `ashpd`'s pattern of stashing a `zbus::Connection` in a process-wide `OnceLock` is fine when you call it from one runtime forever — and fatal when you spawn-then-discard per call. Any time we see `static OnceLock<...>` in a dep, we now ask: which runtime is it bound to, and does that runtime outlive the static?

**Cloud-VPS interface autodetect lies.** On IONOS the public IPv4 is bound `/32` to `ens6` and shows up in `ip -4 addr show`. coturn's libc-based interface enumeration didn't pick it up anyway. Lesson: always pin `listening-ip` + `external-ip` explicitly in cloud deployments. Auto-detect only works on home-server topologies where the public IP sits on the primary interface with a full netmask.

**Perimeter firewall is one more silent-drop layer.** The packets reaching the host don't tell coturn anything, and coturn's healthy listening sockets don't tell UFW anything. From-outside connectivity tests are the only honest signal — `timeout 5 bash -c "exec 3<>/dev/tcp/host/port"` is enough.

**WebRTC ICE has three "host candidate" interpretations:**
1. Raw private IP (legacy, leaks topology) — what our sharer was doing.
2. mDNS `.local` hostname (Chrome's default since 2019, privacy-preserving) — what the viewer was doing.
3. Both. webrtc-rs lets you pick via `MulticastDnsMode`. The default `QueryOnly` accepts incoming mDNS but emits raw IPs. To pair with a Chrome viewer on the same LAN you need `QueryAndGather`. The default isn't safe — it silently fails to find direct paths.

**Input event rate ≠ user-perceptible motion.** Browsers fire `pointermove` at hardware DPI. A 1000 Hz mouse generates 17× more events than the display refresh can render. Any input pipeline that doesn't coalesce will measurably lag under load. rAF is the cheapest correct throttle.

## Things that would be different in a greenfield build

- Single dedicated tokio runtime for "external D-Bus / portal / TURN-fetch" use, started at app boot, never per-call.
- Explicit `listening-ip` always set from env, never relying on coturn's interface scan.
- A pre-flight smoke test in the deploy script that runs the from-outside reachability probes (TCP+UDP) before declaring success. The "coturn says it's listening" + "UFW says nothing" gap cost us hours.
- WebRTC SettingEngine configured at peer-construction time as a single shared default — `QueryAndGather` + DSCP packet markings + custom networktype filter (skip Docker bridges entirely) — not inherited from the crate defaults.
- Input pipeline with explicit coalescing as the protocol layer's responsibility, not the input-capture layer's. Means re-throttling can't be accidentally bypassed by a new send path.

## Commits, in order

```
be86d3f  fix(sharer): portal handshake on long-lived runtime, not per-call
0e7895c  chore(sharer): diagnostic dbg_log on receive_offer + ICE paths
d127c8e  chore(sharer): log TURN URLs + cred lengths on fetch
f37ef22  fix(ops): bind coturn to public IPv4 + advertise external-ip
2ada78c  perf(sharer): mDNS QueryAndGather so peers on same LAN go p2p instead of relay
26edea0  perf(viewer): rAF-throttle pointermove so high-DPI mice don't flood input DC
```
