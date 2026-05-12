# Auffi auf Linux installieren

Diese Anleitung beschreibt die Installation der **Auffi Sharer-App** auf dem Linux-Desktop.

Der **Viewer** (Helfer-Seite) benötigt keine Installation — einfach Browser öffnen und
`https://auffi.app` aufrufen.

---

## Schnell-Installation

```bash
curl -fsSL https://raw.githubusercontent.com/phash/auffi/main/scripts/install-linux.sh | bash
```

Das Skript erkennt die Distribution, installiert Abhängigkeiten und richtet Auffi ein.

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
(KDE, GNOME usw.).

Für PipeWire-Support sind folgende Pakete erforderlich:

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

Die neueste Version herunterladen:
**[GitHub Releases — phash/auffi](https://github.com/phash/auffi/releases)**

Verfügbare Formate: `.AppImage`, `.deb`, `.rpm`

---

## Installation per .deb (Debian/Ubuntu)

```bash
# Datei herunterladen (Version anpassen)
wget https://github.com/phash/auffi/releases/latest/download/auffi_0.2.0_amd64.deb

# Installieren
sudo dpkg -i auffi_0.2.0_amd64.deb

# Falls Abhängigkeiten fehlen:
sudo apt-get install -f
```

Starten: `auffi` oder über das Anwendungsmenü.

---

## Installation per .rpm (Fedora/RHEL)

```bash
# Datei herunterladen
wget https://github.com/phash/auffi/releases/latest/download/auffi-0.2.0-1.x86_64.rpm

# Installieren
sudo rpm -i auffi-0.2.0-1.x86_64.rpm
# oder
sudo dnf localinstall auffi-0.2.0-1.x86_64.rpm
```

---

## Installation per AppImage

```bash
# AppImage herunterladen
wget https://github.com/phash/auffi/releases/latest/download/auffi_0.2.0_amd64.AppImage

# Ausführbar machen
chmod +x auffi_0.2.0_amd64.AppImage

# Ausführen
./auffi_0.2.0_amd64.AppImage

# Optional: Systemweit verfügbar machen
sudo ln -sf "$(pwd)/auffi_0.2.0_amd64.AppImage" /usr/local/bin/auffi
```

AppImages benötigen keine Installation — einfach herunterladen und ausführen.
Optional `libfuse2` installieren, falls das AppImage nicht startet:

```bash
# Debian/Ubuntu
sudo apt-get install -y libfuse2

# Fedora
sudo dnf install -y fuse-libs
```

---

## Manuelle Installation (Tarball)

Falls du die einzelnen Dateien manuell installieren möchtest:

```bash
# Tarball entpacken
tar -xzf auffi-linux-x86_64.tar.gz

# Binary installieren
sudo install -m 755 auffi /usr/local/bin/auffi

# Desktop-Eintrag (optional)
sudo install -m 644 auffi.desktop /usr/share/applications/auffi.desktop

# Icon (optional)
sudo install -m 644 auffi.png /usr/share/pixmaps/auffi.png

# Desktop-Datenbank aktualisieren
sudo update-desktop-database /usr/share/applications/ 2>/dev/null || true
```

---

## Erstmaliger Start

Beim Start erscheint auf **Wayland** ein Screen-Capture-Portal-Dialog ("Choose what to
share") — dieser muss bei **jedem Start** bestätigt werden.  Das ist das
Sicherheitsmodell des Compositors; es gibt keine dauerhafte Freigabe für Screen Capture.

Auf **X11** ist keine zusätzliche Berechtigung notwendig.

Auffi startet und zeigt einen 9-stelligen Code an. Diesen Code gibst du dem Helfer,
der ihn unter `https://auffi.app` eingibt.

---

## Update

### Per .deb / .rpm

Neue Version herunterladen und mit demselben Befehl installieren — dpkg/rpm ersetzen die alte
Version automatisch.

```bash
# .deb
sudo dpkg -i auffi_NEUVERSION_amd64.deb

# .rpm
sudo rpm -U auffi-NEUVERSION-1.x86_64.rpm
```

### Per AppImage

Alte AppImage löschen, neue herunterladen und ausführbar machen. Falls du einen Symlink
angelegt hast, diesen aktualisieren:

```bash
sudo ln -sf "$(pwd)/auffi_NEUVERSION_amd64.AppImage" /usr/local/bin/auffi
```

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

### Per AppImage / Manuell

```bash
sudo rm -f /usr/local/bin/auffi
sudo rm -f /usr/share/applications/auffi.desktop
sudo rm -f /usr/share/pixmaps/auffi.png
# AppImage selbst löschen:
rm -f auffi_*.AppImage
```

### Via install-linux.sh

```bash
curl -fsSL https://raw.githubusercontent.com/phash/auffi/main/scripts/install-linux.sh | bash -s -- --uninstall
```

---

## Probleme & Hilfe

- **Issues:** [github.com/phash/auffi/issues](https://github.com/phash/auffi/issues)
- **Schwarzer Bildschirm auf Wayland:** Screen-Capture-Portal-Dialog bestätigen; PipeWire und xdg-desktop-portal installiert?
- **Verbindung schlägt fehl:** TURN-Fallback ist aktiviert; Firewall auf UDP-Ports 3478/5349 prüfen
