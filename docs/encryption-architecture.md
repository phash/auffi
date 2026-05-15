# Auffi — Wie die verschlüsselte Übertragung funktioniert

Eine technische Erklärung der Krypto-Kette zwischen Sharer (Tauri-Desktop-App) und Viewer (Browser). Backend und TURN-Server sehen jeweils nur das, was sie für ihre Aufgabe brauchen, **nie** den Stream-Inhalt.

Verwandte Dokumente:

- [`docs/protocol.md`](protocol.md) — Wire-Format aller Signaling-Frames
- [`docs/security-review-2026-05.md`](security-review-2026-05.md) — Audit mit konkreten Line-References
- [`docs/security-review-2026-05-14-feedback.md`](security-review-2026-05-14-feedback.md) — Audit der Feedback-Surface
- [`docs/postmortem-2026-05-13-connectivity.md`](postmortem-2026-05-13-connectivity.md) — Wie mDNS-Modus und coturn-Pinning die ICE-Auswahl beeinflussen

## Übersicht — vier Phasen

```
1. Signaling     (übers Backend, WebSocket)         Backend sieht Verbindungs-Metadaten
2. ICE           (Direkt-Pfad-Findung)              STUN-Server sehen public IPs
3. DTLS-Handshake (zwischen den Peers, opaque)       Backend/TURN sehen nur Bytes
4. SRTP / SCTP   (Media + DataChannel)              End-to-End encrypted
```

Wer wann was sieht, im Detail unten.

---

## Phase 1 — Signaling (WebSocket über das Backend)

Sharer und Viewer können sich noch nicht sehen. Beide kennen erst mal nur das Backend.

```
Sharer                  Backend (auffi-backend)              Viewer
  │                              │                              │
  │── WSS /signal ──────────────►│                              │
  │   {type:"register"}          │                              │
  │◄── code-assigned 647-150-237─│                              │
  │                              │                              │
  │                              │◄────────── WSS /signal ──────│
  │                              │   {type:"join", code:"…"}    │
  │◄── peer-joined ──────────────│                              │
  │                              │                              │
  │── confirm:accepted ─────────►│── peer-confirmed ───────────►│
```

Das Backend ([`backend/src/signaling.ts`](../backend/src/signaling.ts)) ist ein **dummer Relay**. Es bekommt drei Sorten Frames:

- **SDP-Offer / SDP-Answer**: Session-Description-Protocol-Strings mit Codec-Info, ICE-Credentials, **DTLS-Fingerprints** der jeweiligen selbst-signierten Zertifikate.
- **ICE-Candidates**: Adress-Tupel `(IP, Port, Protocol)`, mit denen sich die zwei Peers gegenseitig erreichen können.
- **Hello / Bye**: Keepalive.

Das Backend tut für jeden dieser Frames **eine einzige Sache**: weiterleiten an den anderen Peer im selben Room. Es parsed weder SDP noch validiert ICE. Es kann auch nicht — die Inhalte sind verschlüsselt-relevant für den Peer.

**Was das Backend nie sieht**: Pixel, Mauspositionen, Tastatur-Eingaben, Datei-Inhalte, DTLS-Handshake-Material, abgeleitete Schlüssel.

---

## Phase 2 — ICE (Connectivity Check)

Beide Peers sammeln ICE-Candidates und tauschen sie übers Backend aus (immer noch unverschlüsselt, das ist ok — Adressen sind nicht geheim):

| Candidate-Typ | Wer | Beispiel |
|---|---|---|
| **host** | direkter LAN-Zugang | `192.168.1.42:54321` (oder bei uns `peer-xxx.local` über mDNS) |
| **srflx** (server-reflexive) | STUN-erfragte Public-IP | `84.137.42.7:50001` |
| **relay** | TURN-Server-Allocation | `82.165.40.140:49500` (unser coturn in Frankfurt) |

Pro Paar von Candidates wird via STUN ein **Connectivity-Check** gemacht (verschlüsselter Ping mit shared message-integrity). Der erste erfolgreiche Pair-Pfad wird zum „selected pair". Bei NAT-Topologien:

- **Same LAN** → host-host → P2P direkt
- **Verschiedene Internet-Provider, einer hat symmetric NAT** → einer host, einer relay → TURN-vermittelt
- **Beide hinter symmetric NAT** → relay-relay → TURN-vermittelt

Wichtig: **TURN-vermittelt heißt nicht „TURN entschlüsselt"**. coturn sieht den DTLS-Strom als opake UDP-Pakete und schaufelt sie nur zwischen Allocations hin und her. Keine Schlüssel, keine Einsicht.

mDNS-Special ([`sharer/src-tauri/src/webrtc_peer.rs`](../sharer/src-tauri/src/webrtc_peer.rs), `MulticastDnsMode::QueryAndGather`): host-Candidates werden als `xxxxxxxx.local` veröffentlicht statt als rohe IPs. Verhindert IP-Leak im SDP + macht Chrome-Same-LAN-Discovery zuverlässig.

---

## Phase 3 — DTLS-Handshake (der eigentliche Schlüsselaustausch)

Sobald ein Paar einen ICE-Pfad gefunden hat, **läuft DTLS direkt auf diesem Pfad** — über das Backend hinweg, nicht durchs Backend hindurch.

```
                                  ┌────────────────┐
   Sharer ─── ICE-selected-pair ──┤ Internet / NAT ├── Viewer
              (host-host oder      └────────────────┘
               relay über coturn)
              │                                          │
              ▼                                          ▼
        ┌─────────────────────────────────────────────────┐
        │     DTLS 1.3 Handshake (RFC 5764 SRTP-Profile)  │
        │  ─────────────────────────────────────────────  │
        │  1. ClientHello  + ephemeral ECDHE-pubkey       │
        │  2. ServerHello  + ephemeral ECDHE-pubkey       │
        │     + self-signed Cert (Curve P-256)            │
        │  3. Certificate-Verify-Step beider Seiten       │
        │  4. ECDHE → master_secret + extractor (RFC 5705)│
        │  5. SRTP-Profile-Auswahl (AES-128-CM_HMAC-SHA1) │
        │  6. SRTP-Keys + Salts aus master_secret ableiten│
        └─────────────────────────────────────────────────┘
```

Drei Eigenschaften, die alles zusammenhalten:

### 3.1 Forward Secrecy

Beide Peers werfen nach der Session ihren ephemeren ECDHE-Schlüssel weg. Wer den Stream später aufzeichnet *und* eine der Maschinen kompromittiert, kommt nicht zurück an die Schlüssel.

### 3.2 MitM-Schutz über SDP-Fingerprint (das ist der subtile Teil)

Beide Peers signieren mit **selbst-signierten** Zertifikaten (keine CA, kein Let's Encrypt). Ohne weiteren Schutz könnte das Backend einen MitM machen: zwei eigene Zertifikate generieren, zwei DTLS-Streams gleichzeitig, beide Seiten redet mit dem Backend statt direkt.

Verhinderung: im SDP, das beim Signaling übers Backend läuft, sendet jeder Peer einen **Fingerprint** seines Zertifikats (`a=fingerprint:sha-256 AB:CD:…`). Beim DTLS-Handshake wird das tatsächlich präsentierte Cert mit diesem im SDP angekündigten Fingerprint verglichen. Wenn das Backend einen MitM machen wollte, müsste es entweder

- die Fingerprint-Strings im durchgereichten SDP fälschen → fliegt sofort auf, weil der DTLS-Server-Cert nicht zum gefälschten Fingerprint passt → Handshake bricht ab
- oder den DTLS-Server-Cert mit demselben Hash haben → SHA-256-Preimage-Angriff, praktisch unmöglich

Also: **der Server kann das SDP nicht verändern ohne die Sitzung zu zerstören**. Das ist der gleiche Schutz wie HPKP/CT für TLS, nur eingebaut in WebRTC.

### 3.3 SRTP-Profile-Aushandlung

Am Ende des DTLS-Handshakes ist ausgehandelt, welches SRTP-Profil benutzt wird. Auffi / webrtc-rs hat `AES-128-CM_HMAC-SHA1` als Default (RFC 5764). Aus dem DTLS-`master_secret` werden via `keying material exporter` (RFC 5705) abgeleitet:

- SRTP-Key (16 Bytes)
- SRTP-Salt (14 Bytes)
- SRTCP-Key (16 Bytes)
- SRTCP-Salt (14 Bytes)
- Symmetrisch für beide Richtungen

Das Backend hat **keine dieser Werte gesehen** — die ganze Ableitung passiert nach dem ICE-Select direkt zwischen den Peers.

---

## Phase 4 — SRTP für Video, SCTP über DTLS für DataChannel

Ab jetzt sind zwei verschiedene Datenströme aktiv.

### 4.1 Video → SRTP (Secure Real-time Transport Protocol, RFC 3711)

```
RTP-Header (12 Byte) + Encrypted Payload (variable) + Auth-Tag (10 Byte SHA1-HMAC)
└── plaintext ──────────┘   └── AES-128-CTR mit IV ──┘   └── HMAC über kompletten Frame ──┘
```

Pro RTP-Paket:

- **IV** wird aus SRTP-Salt + Packet-Counter konstruiert (RFC 3711 §4.1.1) — niemals Wiederverwendung
- **Encrypt**: AES-128-Counter-Mode über den Payload (Video-Frame-Slice)
- **Auth**: HMAC-SHA1 (10 Bytes truncated) über Header + Encrypted-Payload + Replay-Index
- **Replay-Schutz**: Sliding-Window-Counter (default 64 Pakete) — Pakete mit zu kleinem Counter werden verworfen

Der Sharer ([`sharer/src-tauri/src/webrtc_peer.rs`](../sharer/src-tauri/src/webrtc_peer.rs)) füttert VP8/VP9-Frames in den Encoder, webrtc-rs verpackt sie in SRTP-Pakete und schickt sie über den ICE-Pfad. Der Viewer ([`viewer/src/webrtc-client.ts`](../viewer/src/webrtc-client.ts)) macht die umgekehrte Operation: SRTP-Decrypt → VP8/VP9-Decode → `<video>`-Element.

### 4.2 Input + Files → SCTP über DTLS (DataChannel, RFC 8831)

DataChannel benutzt **kein SRTP**. Stattdessen läuft SCTP (Stream Control Transmission Protocol) **innerhalb** desselben DTLS-Tunnels:

```
                  ┌─── DTLS-Tunnel auf dem ICE-Pfad ───┐
                  │                                    │
    (RTP/SRTP) ───┤ SCTP-Verkehr für DataChannel       │
                  │  ├── `input`  (Maus/Tastatur)      │
                  │  └── `files`  (Datei-Transfer)     │
                  │                                    │
                  └────────────────────────────────────┘
```

Eigenschaften aus der Auffi-Konfiguration ([`viewer/src/data-channels.ts`](../viewer/src/data-channels.ts)):

| Channel | Direction | Ordered | Reliability | Encryption |
|---|---|---|---|---|
| `input` | Viewer → Sharer | nein | unreliable für mouse-move; reliable für buttons/keys | DTLS (gleicher Tunnel wie SRTP) |
| `files` | bi-direktional | ja | reliable ordered | DTLS |

DTLS-Encryption bei SCTP ist record-basiert: jeder SCTP-Chunk wird mit demselben Master-Secret verschlüsselt, das auch für SRTP-Schlüssel verwendet wurde. Same crypto, anderes Framing.

---

## Was wer wirklich sieht

| Komponente | Sieht | Sieht NICHT |
|---|---|---|
| **`auffi-backend`** (Signaling) | 9-stelliger Code, SDP-Offer/Answer-Strings (Codec-Infos, DTLS-Fingerprints), ICE-Candidate-Adressen, Sharer-Bestätigung | Pixel, Eingaben, Dateien, DTLS-Handshake-Material, abgeleitete Schlüssel |
| **`auffi-coturn`** (TURN-Relay) | UDP-Pakete als opake Bytes, Source/Destination-Allocation-IDs, HMAC-Auth-Credentials (RFC 5766) | Identisch verschlüsselt — kann keine SRTP-Pakete entschlüsseln, kein DTLS-Master-Secret |
| **Internet-Router auf dem Pfad** | UDP-Pakete | nichts darüber hinaus, weil DTLS |

---

## Audit-Belege

Aus dem Security-Review vom 2026-05-13 ([`docs/security-review-2026-05.md`](security-review-2026-05.md), Abschnitt 4 „Encryption — verified") sind diese Kanäle und ihre Verifikations-Quellen einzeln gepinnt:

| Channel | Algorithmus | Verified im Code |
|---|---|---|
| Sharer ↔ Backend (Signaling) | TLS 1.2/1.3 via `rustls-tls-native-roots` | [`sharer/src-tauri/Cargo.toml:19`](../sharer/src-tauri/Cargo.toml) |
| Sharer ↔ Backend (TURN-Creds-Fetch) | TLS 1.2/1.3 via `reqwest` + rustls | [`sharer/src-tauri/Cargo.toml:31`](../sharer/src-tauri/Cargo.toml) |
| Viewer ↔ Backend (Signaling) | TLS via Caddy → Backend | [`caddy/Caddyfile`](../caddy/Caddyfile) |
| **Viewer ↔ Sharer (Media + Data)** | **DTLS-SRTP, mandatory** | webrtc-rs default; explizit nicht abgeschaltet in [`sharer/src-tauri/src/webrtc_peer.rs:106-111`](../sharer/src-tauri/src/webrtc_peer.rs) |
| Sharer ↔ coturn (ICE-Relay) | TLS auf dem TURNS-Endpoint (Port 5349) | `Caddyfile:46` |
| Password-Hashes in der DB | argon2id, `m=64 MiB, t=3, p=1` (≈ 250 ms / 1 vCPU) | [`backend/src/auth/argon.ts:14-19`](../backend/src/auth/argon.ts) |
| Token-Hashes in der DB | SHA-256 für Sessions, Email-Verifications, Password-Resets, Device-Tokens | [`backend/src/auth/tokens.ts`](../backend/src/auth/tokens.ts) |
| TURN-Credentials | HMAC-SHA1 über `expiry:uuid`, ≤ 1 h TTL (RFC 5766 mandate) | [`backend/src/turn-credentials.ts:32`](../backend/src/turn-credentials.ts) |

Zusätzlich verifiziert (aus demselben Audit, Tabelle „What's good — verified"):

- **Sharer-Confirmation ist mandatory** — kein Auto-Accept im Ad-hoc-Flow (im Unattended-Mode wahlweise per Device-Passwort gegated).
- **Constant-time Login** — argon2-Verify wird auch beim „unknown account" gegen einen Decoy-Hash gefahren, damit Timing kein User-Existence leakt. [`backend/src/auth/argon.ts:56-84`](../backend/src/auth/argon.ts).
- **Token-Lebenszyklus**: Session-Cookie 30 d, Email-Verification + Password-Reset 24 h und single-use, Device-Pairing-Code 5 min und single-use. Alle als `used_at` innerhalb einer DB-Transaktion markiert.
- **Kein `danger_accept_invalid_certs` / `rejectUnauthorized: false` irgendwo im Code.** Suche und du findest nichts.
- **Keine Plaintext-Secrets persistiert.** Nur Hashes.

---

## Konkret nachlesen

- [`sharer/src-tauri/src/webrtc_peer.rs`](../sharer/src-tauri/src/webrtc_peer.rs) — `setup_peer_connection()`. Hier wird die `SettingEngine` konfiguriert (mDNS-Modus, ICE-Range, DTLS-Cert-Generation).
- [`viewer/src/webrtc-client.ts`](../viewer/src/webrtc-client.ts) — `ViewerPeer.start()`. Browser-seitig dasselbe via Web-API.
- [`backend/src/signaling.ts`](../backend/src/signaling.ts) — siehst, dass das Backend wirklich nur Frames durchreicht. Suche nach `forwardRelay` / der `relay`-Match-Arm.
- [`coturn/turnserver.conf.tmpl`](../coturn/turnserver.conf.tmpl) — `no-loopback-peers`, `denied-peer-ip` etc. Der TURN-Server kann von außen nicht als allgemein-offener Proxy missbraucht werden.
- [`docs/protocol.md`](protocol.md) — die Wire-Frames, alle JSON. Macht klar, dass keine Inhalts-Felder im Signaling vorkommen.
- Audit-Belege: [`docs/security-review-2026-05.md`](security-review-2026-05.md), Abschnitt 2, hat die Verified-Good-Tabelle mit den genauen `webrtc_peer.rs`-Line-References.

---

## RFCs, die das alles definieren

| RFC | Was es regelt |
|---|---|
| **RFC 3711** | SRTP — Secure Real-time Transport Protocol |
| **RFC 5245 → 8445** | ICE — Interactive Connectivity Establishment |
| **RFC 5389 → 8489** | STUN — Session Traversal Utilities for NAT |
| **RFC 5766 → 8656** | TURN — Traversal Using Relays around NAT |
| **RFC 5764** | DTLS-SRTP — Key-Material-Ableitung für SRTP aus dem DTLS-Master-Secret |
| **RFC 5705** | TLS Keying Material Exporter (wie SRTP-Keys aus DTLS rauskommen) |
| **RFC 6347** | DTLS 1.2 (oder 9147 für DTLS 1.3) |
| **RFC 8826** | WebRTC Security Architecture — der Überblicks-Text |
| **RFC 8831** | WebRTC DataChannels |
| **RFC 8833** | WebRTC IdP (für identity, von uns nicht verwendet) |
| **RFC 9116** | security.txt — wo wir Vuln-Reports entgegennehmen, siehe `/.well-known/security.txt` |
