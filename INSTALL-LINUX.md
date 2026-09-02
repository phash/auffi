# Auffi auf Linux installieren (fertige Pakete)

Diese Anleitung installiert die **Auffi Sharer-App** aus den fertigen
Release-Paketen. Wer den Sharer selbst aus dem Source bauen will (inkl.
Arch-PKGBUILD), nimmt [INSTALL.md](INSTALL.md).

Der **Viewer** (Helfer-Seite) benötigt keine Installation — einfach Browser öffnen und
`https://auffi.app` aufrufen.

---

## Schnell-Installation

```bash
curl -fsSL https://raw.githubusercontent.com/phash/auffi/main/scripts/install-linux.sh | bash
```

Das Skript erkennt die Distribution, installiert die Laufzeit-Abhängigkeiten,
ermittelt die neueste Version über die GitHub-Releases-API und installiert das
passende Paket (`.deb` auf Debian/Ubuntu, `.rpm` auf Fedora/RHEL, sonst AppImage).
Eine bestimmte Version erzwingen: `AUFFI_VERSION=vX.Y.Z` vor dem `bash` setzen.

---

## Voraussetzungen

| Paket | Zweck |
|---|---|
| `webkit2gtk-4.1` | WebView-Engine (Tauri) |
| `libvpx` | VP8/VP9 Video-Codec für WebRTC |
| `gstreamer` + `gst-plugins-base` + `gst-plugin-pipewire` | Wayland-Capture-Pipeline |
| X11 oder Wayland + PipeWire | Bildschirmerfassung |

**Wayland-Hinweis:** Auffi unterstützt native Wayland-Capture über
`xdg-desktop-portal` (ScreenCast-Portal) und PipeWire. Beim Start erscheint ein
Systemdialog ("Choose what to share"), den der User bei **jedem Start** bestätigen muss.
Das ist das Sicherheitsmodell des Compositors — es gibt kein "Immer erlauben" für
Screen Capture. Der Dialog erscheint in der Regel als Fenster des Desktop-Environments
(KDE, GNOME usw.). Fehlt `gst-plugin-pipewire`, startet das Streamen auf Wayland gar
nicht („Streamen konnte nicht gestartet werden") — es gibt keinen stillen Fallback.

### Distro-spezifische Abhängigkeiten

**Arch Linux / Manjaro / CachyOS:**
```bash
sudo pacman -S webkit2gtk-4.1 libvpx pipewire xdg-desktop-portal \
    gstreamer gst-plugins-base gst-plugin-pipewire
```

**Debian / Ubuntu (22.04+):**
```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-0 libvpx-dev libpipewire-0.3-dev \
    xdg-desktop-portal libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 \
    libgstreamer-plugins-good1.0-0 gstreamer1.0-pipewire \
    libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev
```

**Fedora / RHEL / CentOS:**
```bash
sudo dnf install -y webkit2gtk4.1 libvpx pipewire xdg-desktop-portal \
    gstreamer1 gstreamer1-plugins-base gstreamer1-plugins-good \
    pipewire-gstreamer
```

---

## Download

Alle Installer sind auf der Download-Seite gebündelt — kein GitHub-Account nötig:

**[https://auffi.app/download/](https://auffi.app/download/)**

Verfügbare Formate: `.AppImage`, `.deb`, `.rpm` (Linux), `.msi`, `.exe`, Portable
`.exe` (Windows). Die aktuelle Versionsnummer steht dort neben den Buttons; die
Downloads laufen über den Stream-Proxy `https://auffi.app/api/downloads/file/<Asset>?tag=vX.Y.Z`
(die Assets liegen auf den [GitHub-Releases](https://github.com/phash/auffi/releases)).
Asset-Namen sind case-sensitiv und beginnen mit großem `A`:

| Format | Asset-Name |
|---|---|
| Debian/Ubuntu | `Auffi_X.Y.Z_amd64.deb` |
| Fedora/RHEL | `Auffi-X.Y.Z-1.x86_64.rpm` |
| AppImage | `Auffi_X.Y.Z_amd64.AppImage` |

Prüfsumme: jedes Release trägt eine `SHA256SUMS`-Datei
(`sha256sum -c --ignore-missing SHA256SUMS`).

---

## Installation per .deb (Debian/Ubuntu)

```bash
# Datei herunterladen (X.Y.Z durch die aktuelle Version ersetzen)
wget "https://auffi.app/api/downloads/file/Auffi_X.Y.Z_amd64.deb?tag=vX.Y.Z" -O Auffi_X.Y.Z_amd64.deb

# Installieren
sudo dpkg -i Auffi_X.Y.Z_amd64.deb

# Falls Abhängigkeiten fehlen:
sudo apt-get install -f
```

Starten: über das Anwendungsmenü („Auffi") oder im Terminal `auffi-sharer`.

---

## Installation per .rpm (Fedora/RHEL)

```bash
wget "https://auffi.app/api/downloads/file/Auffi-X.Y.Z-1.x86_64.rpm?tag=vX.Y.Z" -O Auffi-X.Y.Z-1.x86_64.rpm

sudo dnf localinstall Auffi-X.Y.Z-1.x86_64.rpm
# oder
sudo rpm -U Auffi-X.Y.Z-1.x86_64.rpm
```

---

## Installation per AppImage

```bash
wget "https://auffi.app/api/downloads/file/Auffi_X.Y.Z_amd64.AppImage?tag=vX.Y.Z" -O Auffi_X.Y.Z_amd64.AppImage

chmod +x Auffi_X.Y.Z_amd64.AppImage
./Auffi_X.Y.Z_amd64.AppImage

# Optional: systemweit verfügbar machen
sudo ln -sf "$(pwd)/Auffi_X.Y.Z_amd64.AppImage" /usr/local/bin/auffi
```

AppImages benötigen keine Installation — einfach herunterladen und ausführen.
Falls das AppImage nicht startet, fehlt meist FUSE 2:

```bash
# Debian/Ubuntu
sudo apt-get install -y libfuse2

# Fedora
sudo dnf install -y fuse-libs

# Arch
sudo pacman -S fuse2
```

---

## Erstmaliger Start

Beim Start erscheint auf **Wayland** ein Screen-Capture-Portal-Dialog ("Choose what to
share") — dieser muss bei **jedem Start** bestätigt werden. Das ist das
Sicherheitsmodell des Compositors; es gibt keine dauerhafte Freigabe für Screen Capture.

Auf **X11** ist keine zusätzliche Berechtigung notwendig.

Auffi startet und zeigt einen 9-stelligen Code an. Diesen Code gibst du dem Helfer,
der ihn unter `https://auffi.app` eingibt.

---

## Update

Die App prüft beim Start selbst, ob ein neueres Release existiert, und zeigt
einen Banner mit Link auf die Download-Seite.

### Per .deb / .rpm

Neue Version herunterladen und mit demselben Befehl installieren — dpkg/rpm ersetzen die alte
Version automatisch.

```bash
# .deb
sudo dpkg -i Auffi_NEUVERSION_amd64.deb

# .rpm
sudo rpm -U Auffi-NEUVERSION-1.x86_64.rpm
```

### Per AppImage

Alte AppImage löschen, neue herunterladen und ausführbar machen. Falls du einen Symlink
angelegt hast, diesen aktualisieren:

```bash
sudo ln -sf "$(pwd)/Auffi_NEUVERSION_amd64.AppImage" /usr/local/bin/auffi
```

### Per install-linux.sh

Das Skript einfach erneut laufen lassen — es installiert die neueste Version über die alte.

---

## Deinstallation

### Per .deb

```bash
sudo dpkg -r auffi
# oder vollständig inkl. Konfiguration:
sudo dpkg --purge auffi
```

### Per .rpm

```bash
sudo rpm -e auffi
# oder
sudo dnf remove auffi
```

### Per AppImage

```bash
sudo rm -f /usr/local/bin/auffi
rm -f Auffi_*.AppImage
```

### Via install-linux.sh

```bash
curl -fsSL https://raw.githubusercontent.com/phash/auffi/main/scripts/install-linux.sh | bash -s -- --uninstall
```

---

## Probleme & Hilfe

- **Issues:** [github.com/phash/auffi/issues](https://github.com/phash/auffi/issues)
- **„Streamen konnte nicht gestartet werden" auf Wayland:** `gst-plugin-pipewire`, PipeWire
  und `xdg-desktop-portal` installiert? Portal-Dialog bestätigt? Details in `/tmp/auffi-debug.log`.
- **Verbindung schlägt fehl:** TURN-Fallback ist aktiviert; Firewall auf UDP-Ports 3478/5349 prüfen
