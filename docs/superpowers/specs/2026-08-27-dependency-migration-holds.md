# Dependency-Migration 2026-08-27 — bewusst gehaltene Upgrades

Beim Audit-/Migrations-Pass am 2026-08-27 wurden alle npm-Pakete und die
Windows-verifizierbaren Cargo-Crates auf latest stable gehoben (siehe die
`chore(deps)`-Commits). Vier Upgrades wurden **bewusst NICHT** mitgenommen.
Dieses Dokument hält fest warum, und was die spätere Migration jeweils
braucht — damit der nächste Pass nicht bei null recherchiert.

## 1. webrtc 0.17.x → 0.20.x (sharer) — eigenes Migrationsprojekt

- **Es gibt keine 0.18/0.19.** 0.20 ist der Sans-IO-Rewrite: `webrtc` ist
  nur noch eine dünne async-Schicht über dem `rtc`-Protokoll-Core
  (`runtime-tokio`-Feature). Sämtliche Modulpfade, die `webrtc_peer.rs`
  importiert, existieren nicht mehr.
- Kern-Umbauten für uns:
  - Callback-Registrierung (`on_ice_candidate`, `on_ice_connection_state_change`,
    `on_data_channel`) → `PeerConnectionEventHandler`-Trait, der **zur
    Build-Zeit** übergeben wird ⇒ `SharerPeer`s „construct, then register"
    invertiert; die mpsc-Sender müssen vor dem Peer-Bau existieren.
  - DataChannels werden poll-basiert (`DataChannel::poll()` →
    `DataChannelEvent`), kein `on_message` mehr.
  - `TrackLocalStaticSample::write_sample(ssrc, payload_type, &sample, &[])`
    — `streaming_loop` (lib.rs) muss SSRC + negotiated VP8-PT durchreichen.
  - Stats-API: `get_stats(now, selector)`, Varianten/Structs umbenannt
    (`CandidatePair`→`IceCandidatePair`, `ICE*`→`RTCIce*`) —
    `resolve_connection_type` + 5 Tests neu.
  - `set_ice_multicast_dns_mode` → `set_multicast_dns_mode`
    (`QueryAndGather` existiert weiter — footguns.md-Invariante bleibt
    erfüllbar); `set_nat_1to1_ips` bleibt.
  - rustls-Story unverändert: `rtc` zieht rustls 0.23 mit `ring`-Default;
    der Ring-Provider-Install in lib.rs bleibt korrekt.
- **Warum gehalten:** Rewrite ist erst seit 2026-07-31 stable, 0.21 schon
  in Beta (API bewegt sich noch), und er re-architektiert exakt die
  load-bearing Teile aus `docs/footguns.md` (mDNS-Pairing, TURN-Relay,
  Teardown). Migration nur als eigenes, spec'tes Projekt mit
  Viewer-Interop- und Plasma/Windows-Connectivity-Matrix-Retest.
- Zwischenstand: 0.17.2 (Patch mit ICE/TURN- und Windows-UDP-Fixes) ist drin.

## 2. keyring 3.6.3 → 4.x (sharer) — Datenkompatibilität ungeklärt

- v4 = Architektur-Split (keyring-core + Store-Crates). **Alle vier von uns
  genutzten Feature-Namen existieren nicht mehr** (`linux-native-sync-persistent`,
  `apple-native`, `windows-native`, `crypto-rust`); Ersatz wäre das
  `v1`-Default-Feature + `use keyring::v1 as keyring;` in account.rs.
- **Blocker:** Der Unattended-Device-Token liegt im OS-Store. Es ist
  unverifiziert, ob die v4-Stores (windows-native, zbus-secret-service)
  v3-geschriebene Einträge unter denselben service/user-Attributen
  wiederfinden. Falls nein, bricht **jedes bestehende Pairing** beim Update.
  Außerdem wechselt Linux von keyutils+sync-secret-service auf zbus
  (interne async-Runtime — Verhalten aus unserem sync-Callpfad testen).
- **Vor der Migration:** auf je einem echten Windows- und Linux-Host mit
  bestehendem v3-Token pairen → updaten → Token-Survival prüfen. Sauberer
  Zielzustand laut Upstream: direkt `keyring-core` + nur die zwei Stores,
  die wir shippen (kein macOS).

## 3. ashpd 0.10 → 0.13 + gstreamer 0.24 → 0.25 (sharer, Linux-only)

- Auf dem Windows-Host nicht kompilierbar (gstreamer-sys braucht
  pkg-config/System-Libs) ⇒ Blind-Bump verstößt gegen die
  Verifikationsregel.
- ashpd 0.13: Portale sind einzelne Features (`features = ["tokio",
  "screencast"]` nötig, sonst existiert `desktop::screencast` nicht);
  Screencast-API auf Options-Structs umgestellt — `gst_portal.rs:106-153`
  mechanisch portieren (CreateSessionOptions / SelectSourcesOptions /
  StartCastOptions). zbus 5.x darunter.
- gstreamer 0.25: MSRV 1.92 (ok), Breaking-Items berühren unsere
  `pipewiresrc ! videoconvert ! appsink`-Pipeline nicht; alle drei Crates
  im Lockstep bumpen.
- x11rb 0.14 wurde bereits gebumpt (API-safe für unsere Surface; der
  Linux-CI-Build verifiziert).
- **Nächste Linux-Session:** ashpd-Port + gstreamer-Lockstep-Bump, dann
  `cargo test --lib` + Wayland-Smoke auf Plasma.

## 4. @types/node 25 → 26 (backend/viewer/dashboard)

- @types/node 26 trackt Node 26; die Docker-Runtime ist
  `node:22.22.2-alpine`. Die Types sind schon einen Major voraus — noch
  weiter aufreißen heißt gegen APIs typchecken, die die Runtime nicht hat.
- **Bump zusammen mit** dem Base-Image-Wechsel auf Node 26 LTS
  (nach Okt 2026). Optional stattdessen ehrlich auf @types/node 22 alignen.
