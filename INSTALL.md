# Auffi-Sharer — Linux-Installation (Selber bauen)

Diese Anleitung baut den Sharer aus dem Source und installiert ihn
systemweit. Für reine Endnutzer gibt es daneben die fertigen
[Releases](https://github.com/phash/auffi/releases) als `.deb`,
`.rpm` und `.AppImage`.

> **Webview-Browser & Backend:** Der Viewer-Teil (Browser-SPA) und
> das Signaling-Backend laufen unter `https://auffi.app`. Der
> Sharer baut nur die Desktop-App; ein eigenes Hosting brauchst du
> nur, wenn du die Referenz-Infrastruktur ersetzen willst —
> Anleitung dazu in [`ops/README.md`](ops/README.md).

---

## Voraussetzungen

**Rust-Toolchain.** Für die WebRTC-Library (`webrtc-rs`) brauchst du
einen aktuellen Rust-Compiler. Empfohlen: rustup statt der Distro-
Pakete, damit du deine Toolchain selbst kontrollierst.

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup default stable
```

**Node 22+ und npm.** Tauri-CLI ist eine npm-Devdependency und braucht
moderne Node-Versionen.

**Systemabhängigkeiten:** Webview (webkit2gtk-4.1), GStreamer für
Wayland-Capture (`gst-plugin-pipewire` ist der kritische Teil),
libvpx für den VP8/VP9-Encoder, libxdo für die X11-Input-Injection.

### Arch / Manjaro / EndeavourOS

```bash
sudo pacman -S --needed \
  base-devel git nodejs npm rust \
  webkit2gtk-4.1 gtk3 libsoup3 \
  gstreamer gst-plugins-base gst-plugins-good \
  gst-plugins-bad gst-plugin-pipewire \
  libvpx libxdo xdg-desktop-portal pkgconf patchelf
```

### Debian / Ubuntu (24.04+)

```bash
sudo apt update
sudo apt install -y \
  build-essential curl git pkg-config \
  libwebkit2gtk-4.1-dev libsoup-3.0-dev libgtk-3-dev \
  libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
  gstreamer1.0-pipewire \
  libvpx-dev libxdo-dev xdg-desktop-portal patchelf
# Node 22 LTS via NodeSource:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### Fedora / RHEL-Klone

```bash
sudo dnf install -y \
  git nodejs npm rust cargo \
  webkit2gtk4.1-devel gtk3-devel libsoup3-devel \
  gstreamer1-devel gstreamer1-plugins-base-devel \
  gstreamer1-plugins-good gstreamer1-plugins-bad-free \
  pipewire-libs libvpx-devel libxdo-devel \
  xdg-desktop-portal pkgconf patchelf
```

---

## Variante 1 — Arch: PKGBUILD (`makepkg -si`)

Empfohlen wenn du auf Arch bist: das produziert ein echtes
pacman-Paket, taucht in `pacman -Q` auf und lässt sich sauber
deinstallieren.

```bash
git clone https://github.com/phash/auffi.git
cd auffi/packaging/arch
makepkg -si
```

Das baut den Sharer komplett aus dem Source (dauert auf einem
modernen Laptop ~ 4–6 min, fast alles Cargo-Compilation), packt
das Ergebnis in `auffi-git-<version>-<rel>-x86_64.pkg.tar.zst` und
installiert es via pacman:

| Datei | Pfad |
|---|---|
| Binary | `/usr/bin/auffi` |
| Icon | `/usr/share/icons/hicolor/{32,128,256}x{...}/apps/auffi.png` |
| Desktop-Entry | `/usr/share/applications/auffi.desktop` |
| Lizenz | `/usr/share/licenses/auffi-git/LICENSE` |

Deinstallieren:

```bash
sudo pacman -R auffi-git
```

---

## Variante 2 — Debian/Ubuntu: `.deb` aus dem Source

```bash
git clone https://github.com/phash/auffi.git
cd auffi/sharer
npm ci
npm run tauri:build
sudo dpkg -i src-tauri/target/release/bundle/deb/Auffi_*_amd64.deb
```

Deinstallieren:

```bash
sudo apt remove auffi
```

---

## Variante 3 — Fedora/RHEL-Klone: `.rpm` aus dem Source

```bash
git clone https://github.com/phash/auffi.git
cd auffi/sharer
npm ci
npm run tauri:build
sudo rpm -i src-tauri/target/release/bundle/rpm/Auffi-*.x86_64.rpm
```

---

## Variante 4 — AppImage (jede Distro, kein Install)

Wenn dir System-Install zu invasiv ist, oder du kein Root hast.
Tauris AppImage-Bundling ist standardmäßig aktiv.

```bash
git clone https://github.com/phash/auffi.git
cd auffi/sharer
npm ci
npm run tauri:build
chmod +x src-tauri/target/release/bundle/appimage/Auffi_*.AppImage
src-tauri/target/release/bundle/appimage/Auffi_*.AppImage
```

Die AppImage trägt alle GStreamer- und Webview-Dependencies bei
sich; nur PipeWire muss auf dem Host laufen (was es auf modernen
Distros eh tut).

---

## Erste Schritte nach der Installation

1. **App starten:** Über den App-Launcher (Plasma / GNOME) oder im
   Terminal `auffi`. Das Tray-Icon (rechts oben / unten) bleibt
   sichtbar solange die App läuft.

2. **Ad-hoc-Modus** (Standard): Code anzeigen lassen → an den Helfer
   weitergeben → Helfer öffnet `https://auffi.app` und tippt den
   Code ein → du klickst „Akzeptieren". Kein Konto nötig.

3. **Unattended-Modus** (für eigene Geräte): in den Einstellungen auf
   „Mit Konto verbinden" umstellen → Dashboard öffnen
   ([`https://auffi.app/dashboard/`](https://auffi.app/dashboard/))
   → Konto anlegen → Geräte-Pairing-Code generieren → in der App
   eingeben → Geräte-Passwort setzen → „Starten". Ab dann
   verbindest du dich aus dem Dashboard heraus ohne Code.

---

## Troubleshooting

### „No display" / Wayland funktioniert nicht

Plasma 6 oder GNOME 47+ brauchen den **GStreamer-PipeWire-Plugin
(`gst-plugin-pipewire`)**. Auf Arch heißt das Paket genau so; auf
Debian/Ubuntu `gstreamer1.0-pipewire`; auf Fedora `pipewire-libs`.
Wenn der Plugin fehlt fällt Auffi auf den XWayland-Pfad zurück und
zeigt dir nichts an.

Check:

```bash
gst-inspect-1.0 pipewiresrc | head -3
```

Sollte ohne Fehler die Plugin-Info ausgeben.

### Compile-Fehler: `webrtc-rs`

WebRTC ist die größte Cargo-Crate im Tree (~50% der Compile-Zeit).
Wenn du auf einer 4-GB-VM baust, schwingt der Compiler die Linker-
Hammer-Phase mit hohem Memory-Bedarf. Empfehlung:

```bash
# In sharer/src-tauri/.cargo/config.toml (gitignored):
[profile.release]
codegen-units = 16    # parallelisiert dafür ist Resultat ~3 % langsamer
```

### `auffi-debug.log`

Die Tauri-CLI schluckt `println!` / `eprintln!` aus Command-Handlern.
Logs landen stattdessen in `/tmp/auffi-debug.log`. `tail -f` dort
beim Reproduzieren von Bugs.

---

## Backend ersetzen (Self-Hosting)

Standardmäßig zeigt der Sharer auf `wss://auffi.app/signal`. Wenn
du die Referenz-Infrastruktur durch eine eigene ersetzen willst,
setz die Umgebungsvariable beim Start:

```bash
AUFFI_BACKEND_WS=wss://meine-domain/signal auffi
```

Anleitung zum Aufsetzen eines eigenen Backends (Docker Compose
mit Caddy + coturn): [`ops/README.md`](ops/README.md).

---

## Mitwirken

Bevor du an Auffi entwickelst, lies [`CLAUDE.md`](CLAUDE.md) — dort
stehen die Code-Konventionen, der TDD-Workflow und die nicht-
verhandelbaren Sicherheits-/DSGVO-Regeln. Bugs und Feature-Wünsche
gerne via [GitHub Issues](https://github.com/phash/auffi/issues)
oder direkt aus der App über den Feedback-FAB.
