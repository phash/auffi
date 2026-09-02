# Changelog

Alle nennenswerten Änderungen an Auffi werden in dieser Datei dokumentiert.

Format folgt [Keep a Changelog](https://keepachangelog.com/de/1.1.0/) und das
Projekt nutzt [Semantic Versioning](https://semver.org/lang/de/).

## [0.7.1] — 2026-09-02

Wartungs-Release nach einer vollständigen Durchsicht des Codes (Review mit
neun parallelen Lanes, 259 Befunde verifiziert, davon 5 hoch, 45 mittel und
der Rest niedrig). Keine neuen Funktionen; Bedienung und Wire-Format bleiben
kompatibel zu 0.7.0.

### Sicherheit

- **Dateiempfang wartet auf „Annehmen“.** Der Viewer legte den Empfang schon
  beim Angebot an; ein Sharer, der ohne `file-accept` sendete, bekam seine
  Datei gespeichert, während der Dialog noch offen war. Daten vor der
  Zustimmung verwerfen den Transfer jetzt.
- **Login-Lockout wie bei `/api/me`:** fünf Fehlversuche sperren das Konto
  15 Minuten; die Antwort bleibt das generische 401 (keine
  Konto-Enumeration). Versuche werden vor argon2 gezählt und bei Erfolg
  vergeben — ein paralleler Burst kann nicht mehr Rateversuche als die
  Schwelle verifizieren. Der letzte aktive Admin kann sich nicht selbst
  löschen (409).
- Sitzungen prüfen bei jedem Request die Sperre des Kontos; ein Login, der
  mit einem Reset oder einer Sperre rennt, wird nach argon2 erneut geprüft.
  Passwort-Reset-Token werden atomar in der Transaktion verbraucht.
- Nie bestätigte, nie genutzte Konten werden nach 7 Tagen gelöscht
  (Retention-Lücke; Datenschutzerklärung aktualisiert). SMTP auf 587/25
  verlangt STARTTLS.
- Join-Versuche verbrauchen das per-IP-Budget vor dem Code-Lookup — ein
  erschöpftes Budget lässt auch einen Treffer nicht mehr durch. Rate-limitierte
  Bearer-Upgrades schließen mit 4429 statt 4401, damit ein Gerät hinter einem
  vollen NAT nicht dauerhaft als „widerrufen“ offline geht.
- Sharer: der Zugriffsdialog fokussiert „Ablehnen“; „Gerät entkoppeln“ beendet
  eine laufende Sitzung sofort und schickt dem Helfer ein `bye`; das
  Geräte-Token erscheint nicht mehr in `Debug`-Ausgaben; `pw-check-result`
  trägt eine `attemptId`, damit eine späte Antwort nicht dem nächsten Helfer
  zugeordnet wird.

### Behoben

- **Viewer:** ICE-Kandidaten, die vor der SDP-Antwort eintreffen, werden
  gepuffert statt mit „ICE-Fehler“ abzubrechen; gehaltene Tasten und
  Maustasten werden beim Fokusverlust des Fensters losgelassen; `f` schaltet
  bei aktiver Steuerung nicht mehr den lokalen Vollbild-Modus; „Steuerung
  aktivieren“ wartet auf die Datenkanäle; ein `peer-rejected`/`error` nach der
  Bestätigung wird sofort angezeigt statt nach 30 s als Firewall-Hinweis;
  Enter im Passwort-Prompt sendet keinen zweiten Versuch; parallele
  Datei-Angebote überschreiben einander nicht mehr.
- **Sharer (App):** „Neu verbinden“ war per CSS unsichtbar; der Heartbeat für
  den unbeaufsichtigten Modus startet beim App-Start; der Pause-Hotkey wird
  beim Sitzungsende wieder freigegeben; ein `bye` vor der Bestätigung schließt
  den Dialog und behält den Code; Signaling-Abbruch und ICE-Verlust räumen die
  Streaming-Buttons ab; Doppelklick auf Akzeptieren startet keinen zweiten
  Stream; Modus „unbeaufsichtigt“ lässt sich nicht ohne Pairing + Passwort
  wählen.
- **Sharer (Rust):** RTP-Zeitstempel folgen der Capture-Zeit (kein
  Bitraten-Einbruch auf statischen Bildschirmen unter REMB); der
  Datei-Kanal unterscheidet Text- und Binärframes statt am ersten Byte zu
  raten; anhaltende Encoder-Fehler beenden den Stream sichtbar; Frames mit
  abweichender Größe werden verworfen; Wayland gibt PipeWire-FD und
  Portal-Session frei; Tastatureingaben nutzen den vom Viewer gesendeten
  Layout-`key` (QWERTZ, Umlaute); Capture und Encode laufen nicht mehr auf
  tokio-Workern; UPnP-Adresse wird nicht mehr prozesslebenslang gecacht;
  Debug-Log mit 0600 und ohne Symlink-Verfolgung.
- **Backend:** Server-seitige WS-Pings räumen stille Viewer-Sockets auf
  („session full“-Sackgasse); Frames vor `unattended-hello` werden gepuffert
  statt fatal beantwortet; SIGTERM/SIGINT beenden sauber; Download-Proxy
  antwortet 502 mit Timeout; Purge-Log zählt alle Tabellen; Migrations-
  `PRAGMA foreign_keys` wirkt wieder; `?limit=1.5` und doppelte `q`-Parameter
  liefern 400 statt 500; Feedback-Mutation und Audit in einer Transaktion.
- **Dashboard:** Fokus kehrt nach Modals zum Auslöser zurück; 401 aus späten
  Antworten navigiert nicht mehr aus einer anderen View; Admin-Routen ohne
  Sitzung führen zum Login statt zur 403-Seite; 423/429 werden deutsch
  angezeigt; Intervall- und Timer-Leaks behoben.
- **Website/CSP:** Inline-`<style>` der Vergleichsseiten und der 404-Seite
  lagen unter `style-src 'self'` — die Tabellen erschienen live unformatiert.
  Stile liegen jetzt in `/compare.css` und `/404.css`; Guard-Test.
- **Ops:** `deploy.sh` taggte das neue Image unter dem laufenden SHA um, sodass
  `--rollback` das neue Image startete; Rollback sichert jetzt auch
  viewer-/dashboard-dist; Actions per SHA gepinnt; SSH-Host-Key gepinnt;
  `busybox` gepinnt; Ops-Shell-Tests in CI; Windows-Emulator-Smoke ist pro
  Release in vier Minuten wiederholbar (`.win-test/run.sh`).

### Geändert

- Dokumentation: `docs/protocol.md` (Transport-Liveness, Close-Codes,
  `attemptId`, `key`, REST-Verträge), `docs/footguns.md`, `INSTALL*.md`,
  `README.md`, `docs/encryption-architecture.md` (DTLS 1.2, TTLs) und dieses
  Changelog (0.6.5–0.7.0 nachgetragen) gegen den Code abgeglichen.
- Toter Code entfernt (u. a. `TurnConfig.realm`, die `url`-Abhängigkeit,
  Legacy-CSS-Tokens, stale `eslint-disable`); Backend-Tests
  werden in CI typgeprüft; Backend-Image ohne devDependencies.

## [0.7.0] — 2026-08-31

### Hinzugefügt

- **Die Bildqualität passt sich der Leitung an.** Der Encoder lief seit jeher
  mit festen 2000 kbps, egal was die Verbindung hergab — auf einem
  Handy-Hotspot oder einem dünnen DSL-Upload hieß das dauerhaft zerrissenes
  oder einfrierendes Bild ohne Weg zurück (gh #120). Der Sharer liest jetzt die
  Receiver-Reports des Helfers (RFC 3550) und regelt die Bitrate nach dem
  verlustbasierten GCC-Controller in beide Richtungen: runter, wenn Pakete
  verloren gehen, wieder hoch, sobald die Leitung es trägt; REMB wird als
  Obergrenze berücksichtigt. `bitrate_controller.rs` ist pur und trägt eine
  Closed-Loop-Simulation gegen einen Engpass-Link als Test.

### Behoben

- Die geregelte Bitrate startet mit jeder Sitzung wieder beim Ausgangswert
  statt beim Endwert der vorigen.
- Download-Seite: die Installationsbefehle im Text werden mit dem Release
  mitgebumpt (bisher nannten sie nach dem Bump die Vorversion); Guard in
  `viewer/tests/marketing-pages.test.ts`. Windows-Smoke-Harness repariert.

## [0.6.9] — 2026-08-31

Ersetzt das zurückgezogene 0.6.8 (s. u.) — gleicher Inhalt plus zwei Fixes,
die dort fehlten.

### Behoben

- **Kein schwarzes Bild mehr bei ruhendem Bildschirm.** Der einzige Keyframe
  wurde vor ICE-`connected` encodiert und verpuffte; ein statischer Bildschirm
  löst keinen weiteren aus, und die Picture-Loss-Indication des Helfers wurde
  nie gelesen. Der Sharer sendet jetzt beim Verbinden einen Keyframe und
  beantwortet PLI.
- **Keyframe-Anfragen sind gedrosselt** (max. eine pro Sekunde für
  Viewer-getriebene Anfragen) — ohne Throttle beantwortete 0.6.8 Paketverlust
  mit noch mehr Bytes, was auf verlustreichen Leitungen einen Keyframe pro
  Frame erzwang.
- **Teilen endet, wenn die Gegenseite weg ist.** ICE `disconnected` (10 s
  Karenz für WLAN-Aussetzer), `failed` und `closed` wurden im Sharer
  verworfen; Aufnahme, Encoder und Relay liefen unbemerkt weiter. Die
  Viewer-Policy (`ice-state-handler.ts`) ist jetzt auf den Sharer gespiegelt.

## [0.6.8] — 2026-08-31 [YANKED]

Zurückgezogen (`gh release edit v0.6.8 --prerelease`): der Build enthielt die
PLI-Antwort, aber weder den Keyframe-Throttle noch den ICE-Teardown — auf
verlustreichen Leitungen entstand eine Rückkopplungsschleife. Die Live-Seite
war nie betroffen (Buttons sind seit 0.6.6 auf `?tag=` gepinnt). Nutze 0.6.9.

## [0.6.7] — 2026-08-29

### Hinzugefügt

- **Verbindungs-Statistik für gepairte Geräte** (gh #109): Dauer und Art
  (direkt/Relay) jeder Verbindung landen im Geräte-Protokoll des Dashboards.

### Behoben

- **Die Geräte-ID steht wieder in der Statuszeile** — im unbeaufsichtigten
  Modus zeigte die App nur „Verbunden", ohne die Nummer, die der Helfer
  eintippen muss.
- **Entkoppeln wirkt jetzt auch serverseitig** und räumt die
  Rate-Limit-Buckets des Geräts mit ab (bisher blieb eine Zeile zu einem
  gelöschten Gerät dauerhaft stehen).
- Admin-Nutzersuche: der Debounce überlebte den Seitenwechsel nicht mehr und
  konnte den Admin nicht mehr auf `/login` werfen.

### Sicherheit

- Dateitransfer: `image/svg+xml` fällt nicht mehr durch die MIME-Allow-List
  (SVG kann Script tragen).

## [0.6.6] — 2026-08-28

### Behoben

- **Verbindet sich auch auf frisch installiertem Windows.** rustls vertraute
  nur dem OS-Zertifikatsspeicher, den Windows erst lazy befüllt — auf einem
  frischen Windows 11 scheiterte jede Verbindung mit `UnknownIssuer`, obwohl
  Edge dieselbe Seite lud (ISRG Root X2). Beide Signaling-WebSockets nutzen
  jetzt OS-Store **plus** Mozilla-Bundle als Untergrenze; private CAs für
  Self-Hoster funktionieren weiter.

## [0.6.5] — 2026-08-28

### Sicherheit

- **Ein einzelnes fehlerhaftes Datenpaket konnte den Signaling-Server
  beenden** und alle laufenden Sitzungen trennen (nicht-Objekt-JSON-Frame).
  Wird jetzt mit `bad-message` abgewiesen.
- **Account-Sperre kappt den unbeaufsichtigten Zugriff tatsächlich** — ein
  suspendierter Account konnte sich bisher weiter über gepairte Geräte
  verbinden.

### Behoben

- **Zugriff entziehen beendet die Sitzung sofort** — Gerät im Dashboard
  löschen oder den unbeaufsichtigten Modus abschalten trennt eine gerade
  laufende Fernsteuerung.
- **Pause-Taste gibt gedrückte Tasten frei** — pausierte man mitten im
  Ziehen, blieb die Maustaste am System gedrückt.
- Der Sharer schließt den Peer, wenn `start_streaming` nach dem Aufbau
  fehlschlägt (kein hängender Peer mehr).
- „Beenden" bleibt sichtbar, während auf das erste Bild gewartet wird.
- Dashboard: fehlende Route für die E-Mail-Änderungs-Bestätigung ergänzt.
- Download-Seite: alle Buttons sind auf `?tag=vX.Y.Z` gepinnt, damit ein
  laufender Release-Vorgang keine 404/502 auf der Live-Seite erzeugt.

## [0.6.4] — 2026-07-02

### Behoben

- **Unbeaufsichtigter Zugriff: nur der erste Helfer konnte sich verbinden.**
  `disconnect_streaming` verwarf beim Teardown den vom Heartbeat verwalteten
  Outbound-Kanal, sodass jeder weitere Viewer keine SDP-Antwort mehr erhielt
  (schwarzer Bildschirm). Der Unattended-Kanal überlebt jetzt den
  Per-Viewer-Teardown; die Webview räumt einen stehengebliebenen Peer vor dem
  Neustart ab.
- **Reconnect-Backoff wurde nach einer gesunden Sitzung nicht zurückgesetzt** —
  nach mehreren kurzen Aussetzern konnte ein Reconnect bis zu ~90 s dauern.
  Eine gesunde Verbindung startet die Backoff-Kurve jetzt neu (hält die
  30-s-Session-Reuse-Zusage).
- **Ad-hoc: ein Ersatz-Helfer auf demselben Code muss neu bestätigt werden.**
  Nach dem Verlassen des ersten Helfers blieb die Sitzung „bestätigt", sodass
  ein neuer Helfer ohne Freigabe durchgereicht wurde und der Teilende ihn nicht
  ablehnen konnte.
- **Dashboard:** eine langsame Server-Antwort überschrieb nicht mehr die neue
  Seite nach schnellem Weiterklicken; Router-/Timer-Listener-Leaks behoben.
- Hinweis zur kostenlosen Relay-Zeit wird jetzt auch dem Teilenden angezeigt;
  Bildschirmaufnahme-Fehler landen im Diagnose-Log statt verloren zu gehen.

### Sicherheit

- **Löschen eines Geräts/Accounts trennt die aktive Verbindung sofort.** Zuvor
  blieb ein widerrufenes Gerät bis zum nächsten Reconnect verbunden.
- **Der Sharer kann sich per eigenem Geräte-Token selbst entkoppeln** (der
  „Entkoppeln"-Button widerruft jetzt auch serverseitig; ein Token kann nur das
  eigene Gerät löschen).
- **Signaling gegen einen Absturz gehärtet:** eine FK-Verletzung beim
  Verbindungs-Log (Gerät während offener Verbindung gelöscht) beendet nicht mehr
  den ganzen Backend-Prozess.

## [0.6.3] — 2026-06-22

### Behoben

- **Flüssigere Übertragung auf Windows ohne GPU / über Remotedesktop.** Der
  VP8-Encoder lief mit der langsamsten Bewegungssuche (cpu-used=0) und kam beim
  Software-Encoding eines ganzen Desktops auf GPU-losen Hosts nicht hinterher —
  das Bild ruckelte stark. Encoder jetzt auf Echtzeit getrimmt
  (`VP8E_SET_CPUUSED=8`, `VPX_CBR`, geringe Latenz). Das „alive"-Diagnose-Log
  nennt zusätzlich effektive FPS + mittlere Encode-Zeit zur weiteren Analyse.

## [0.6.2] — 2026-06-22

### Behoben

- **Windows-Bildschirmaufnahme schlug fehl.** Der 0.6.0-Windows-Build brach mit
  „Streamen konnte nicht gestartet werden" ab (`E_NOINTERFACE`), weil der
  Capture-Worker-Thread kein initialisiertes COM/WinRT-Apartment hatte. Fix:
  `CoInitializeEx(MTA)`-RAII-Guard auf dem Capture-Thread + GDI-BitBlt-Fallback
  für RDP / Hosts ohne GPU (inkl. 3-s-First-Frame-Probe, ab der WGC als
  unbrauchbar gilt).

### Sicherheit

- **Diagnose-Log gehärtet** — auf Unix mit `O_NOFOLLOW` + Mode `0600` atomar
  angelegt (kein Symlink-Redirect, kein Mitlesen durch andere lokale Nutzer).
- **TURN-URLs redacten IP-Literale** vor dem Logging (keine Relay-Infra-Preisgabe).
- **GDI-Capture-Härtung** — als `!Send` markiert, `checked_mul` auf die
  Frame-Buffer-Größe, `SelectObject`-`HGDI_ERROR`-Check; Dateiübertragung
  schützt Windows-Reserved-Names (CON/NUL/COM1…).

### Geändert

- **Code-Ablauf-UX** — ein vollständiger Teardown (Beenden) gibt den Ad-hoc-Code
  frei und entfernt ihn vom Bildschirm; ein reiner Viewer-Wechsel behält ihn.
  Der Sekunden-Countdown spammt Screenreader nicht mehr (`aria-live` entfernt).

## [0.6.0] — 2026-06-16

### Hinzugefügt

- **Land des Zuschauers im Bestätigungsdialog** — beim Ad-hoc-Verbinden zeigt
  der Sharer das Land der anfragenden Person an (optionaler GeoIP-Lookup).

### Geändert

- **„Calm Fresh"-Design** für die Sharer-Oberfläche (emerald/mint, AA-Kontrast
  in hell und dunkel), plus Härtungen (kein IP-basiertes Auto-Akzeptieren,
  Cleartext-URL-Schutz) und aktualisierte Abhängigkeiten. Linux + Windows über
  die Release-CI; macOS weiterhin nicht gebaut.

## [0.5.0] — 2026-05-29

Bündelt die Ergebnisse eines Security- und UX-Reviews.

### Sicherheit

- **TURN-Relay-SSRF geschlossen.** coturn verweigert jetzt Relays zu allen
  Special-Use-/Private-Bereichen (RFC1918, Loopback, Link-Local inkl.
  Cloud-Metadata `169.254.169.254`, CGNAT, IPv4-mapped IPv6) — ein Client mit
  TURN-Credentials kann den Relay nicht mehr als internen Port-Scanner gegen
  Backend, Matomo oder Nachbar-Container missbrauchen.
- **`X-Forwarded-For`-Spoofing entschärft.** Das Backend traut nur noch genau
  einem Proxy-Hop (`trustProxy: 1` statt `true`), damit eine gefälschte
  XFF-Kette die Per-IP-Rate-Limits nicht aushebeln kann.
- **Feedback-Endpoint gegen argon2-DoS gehärtet.** Der Sharer-Bearer-Pfad von
  `POST /api/feedback` hat ein eigenes, engeres Per-IP-Limit vor dem
  argon2-Verify (analog zum Signaling-Bearer-Cap).

### Geändert

- **Viewer: verständliche Fehlermeldungen statt Roh-Codes.** Falscher/
  abgelaufener Code, gesperrter Code, abgelehnte Anfrage usw. erscheinen jetzt
  als deutscher Klartext mit Handlungspfad statt `Fehler: invalid-code …`.
- **Viewer: kein Endlos-Spinner mehr.** Ein Connect-Timeout (mit Firewall-
  Hinweis, wenn kein Relay erreichbar war) und ein sichtbarer
  „Abbrechen"-Button geben immer einen Ausweg aus „Warte auf Bestätigung…".
- **Downloads auf der Startseite laufen über den Proxy.** Die Windows-Buttons
  zeigen nicht mehr direkt auf GitHub (keine IP an Dritte, server-seitiger
  Zähler) — konsistent mit der `/download/`-Seite.

### Behoben

- Defekter „Setup-Installer"-Link auf der Startseite (zeigte auf ein nicht
  existierendes Asset → 404).
- Zwei latente Typfehler im Sharer-Webview (nie typgeprüft, da der Build via
  esbuild läuft).

### Intern

- Geteilter Per-IP-Rate-Limiter (`rate-limit.ts`), CI-Jobs für Dashboard +
  Sharer-Webview, `tsc --noEmit`-Gates, Dashboard-Coverage-Tooling,
  Sharer-`tsconfig.json`, Entfernung veralteter `dead_code`-Allows,
  Protokoll-Doku für den Unattended-Flow.

## [0.4.5] — 2026-05-21

### Hinzugefügt

- **Update-Notifier im Sharer.** Beim App-Start ein einmaliger Check
  gegen die GitHub-Releases-API; wenn eine neuere Version verfügbar
  ist, erscheint ein blauer Banner mit Link auf
  [auffi.app/download/](https://auffi.app/download/). Bei Netzwerk-
  oder Parse-Fehler bleibt der Banner versteckt — kein „konnte nicht
  prüfen"-Toast.
- **Download-Proxy via `auffi.app`.** Statt auf GitHub-Releases zu
  redirecten, streamt der Backend die Asset-Bytes direkt durch (Route
  `/api/downloads/file/:asset`, optional `?tag=vX.Y.Z` zum Pinnen). Per-
  Version-Counter inkrementiert serverseitig — kein Client-JS-Hop mehr.

### Behoben

- **HEAD-Requests bumpen den Download-Counter nicht mehr** und fetchen
  den Upstream nicht. Link-Preview-Crawler und Uptime-Checks zählen
  jetzt nicht mehr als echte Downloads.

## [0.4.4] — 2026-05-20

### Behoben

- **Windows: Cursor-Flicker eliminiert.** Die System-Cursor flackerte
  sichtbar, sobald ein Viewer verbunden war. Ursache war eine pro Frame
  neu geöffnete WGC-Capture-Session (~30/s), die DWMs Cursor-Compositing
  fortlaufend umschaltete. Jetzt eine persistente Capture-Session pro
  Stream-Lifetime.
- **Sauberes Capture-Stopp** auf Windows und Linux/X11. Nach dem Trennen
  blieb der Capture-Thread weiterlaufen, bis der Sharer komplett beendet
  wurde. Stop-Signal wird jetzt zuverlässig innerhalb von ≤500 ms erkannt.

### Geändert

- Windows-Asset-Naming wechselt auf das Tauri-Standard-Schema
  (`Auffi_0.4.4_x64-setup.exe` und `Auffi_0.4.4_x64_en-US.msi` statt der
  bisherigen `auffi-sharer-windows-x64-*.exe`).

## [0.4.3] — 2026-05-20

### Hinzugefügt

- **Markanter „Verbinden"-Notch** oben mittig auf der Website (#104).
  Springt auf der Hauptseite per Klick mit weichem Scroll + Fokus zur
  Code-Eingabe; auf den Marketing-Subpages (Impressum, Datenschutz,
  Download) führt der Notch zurück zur Startseite und fokussiert dort
  den Code-Input.

## [0.4.2] — 2026-05-17

### Sicherheit

- **8 transitive CVEs in der TLS-Stack gepatcht** (RUSTSEC-2026-0046 /
  0047 / 0048 / 0049 / 0098 / 0099 / 0104). Drei High-Severity (Cert-
  Chain-Bypass, Signatur-Bypass, CRL-Logik in aws-lc) und vier Medium
  in rustls-webpki (Name-Constraints, CRL-Panic). Empfohlen für alle
  gepairten Unattended-Geräte.

## [0.4.1] — 2026-05-17

### Behoben

- **Sharer-Steuerung-Lockup nach Trennen.** Eine evtl. noch gehaltene
  Maustaste blieb beim Browser-Disconnect „gedrückt"; das eigene Klicken
  war danach unbrauchbar bis der Sharer-Prozess komplett beendet wurde.
  Automatisches Release-on-Drop in der Input-Pipeline (#97).

## [0.4.0] — 2026-05-14

### Hinzugefügt

- **Unattended Access** — Geräte einmal pairen, dann ohne Code aus dem
  Dashboard verbinden. Auto-Accept oder Geräte-Passwort konfigurierbar
  pro Gerät.
- **Wayland-native Capture** — Plasma 6 und GNOME 47+ funktionieren
  nativ via GStreamer/PipeWire, kein XWayland-Fallback mehr.
- **Feedback-Dialog in der App** — direkt aus dem Sharer (im Unattended-
  Modus) oder dem Dashboard Bugs und Wünsche einreichen.
- **Konto + Dashboard** — Geräteliste, Connection-Log, Auto-Accept-
  Toggle, Geräte-Pairing über
  [auffi.app/dashboard/](https://auffi.app/dashboard/).

### Sicherheit

- **Härtungen** — argon2id für Passwörter, `__Host-`-Session-Cookies,
  Per-Account-Lockout, HMAC-ephemerale TURN-Credentials. Vollständiger
  Audit: [docs/security-review-2026-05.md](docs/security-review-2026-05.md).

[0.7.1]: https://github.com/phash/auffi/releases/tag/v0.7.1
[0.7.0]: https://github.com/phash/auffi/releases/tag/v0.7.0
[0.6.9]: https://github.com/phash/auffi/releases/tag/v0.6.9
[0.6.8]: https://github.com/phash/auffi/releases/tag/v0.6.8
[0.6.7]: https://github.com/phash/auffi/releases/tag/v0.6.7
[0.6.6]: https://github.com/phash/auffi/releases/tag/v0.6.6
[0.6.5]: https://github.com/phash/auffi/releases/tag/v0.6.5
[0.6.4]: https://github.com/phash/auffi/releases/tag/v0.6.4
[0.6.3]: https://github.com/phash/auffi/releases/tag/v0.6.3
[0.6.2]: https://github.com/phash/auffi/releases/tag/v0.6.2
[0.6.0]: https://github.com/phash/auffi/releases/tag/v0.6.0
[0.5.0]: https://github.com/phash/auffi/releases/tag/v0.5.0
[0.4.5]: https://github.com/phash/auffi/releases/tag/v0.4.5
[0.4.4]: https://github.com/phash/auffi/releases/tag/v0.4.4
[0.4.3]: https://github.com/phash/auffi/releases/tag/v0.4.3
[0.4.2]: https://github.com/phash/auffi/releases/tag/v0.4.2
[0.4.1]: https://github.com/phash/auffi/releases/tag/v0.4.1
[0.4.0]: https://github.com/phash/auffi/releases/tag/v0.4.0
