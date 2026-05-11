# Screenie auf Linux installieren

Diese Anleitung beschreibt die Installation der **Screenie Sharer-App** auf dem Linux-Desktop.

Der **Viewer** (Helfer-Seite) benötigt keine Installation — einfach Browser öffnen und
`https://screenie.mr-development.de` aufrufen.

---

## Schnell-Installation

```bash
curl -fsSL https://raw.githubusercontent.com/phash/screenie/main/scripts/install-linux.sh | bash
```

Das Skript erkennt die Distribution, installiert Abhängigkeiten und richtet Screenie ein.

---

## Voraussetzungen

| Paket | Zweck |
|---|---|
| `webkit2gtk-4.1` | WebView-Engine (Tauri) |
| `libvpx` | VP8/VP9 Video-Codec für WebRTC |
| X11 oder XWayland | Bildschirmerfassung |

**Wayland-Hinweis:** Screenie nutzt XWayland als Fallback auf Wayland-Sessions. Bildschirmerfassung
funktioniert, aber native Wayland-Capture (via PipeWire) ist noch nicht implementiert. Die
Capture-Qualität unter XWayland kann geringfügig schlechter sein.

### Distro-spezifische Abhängigkeiten

**Arch Linux / Manjaro:**
```bash
sudo pacman -S webkit2gtk-4.1 libvpx
```

**Debian / Ubuntu (22.04+):**
```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-0 libvpx-dev
```

**Fedora / RHEL / CentOS:**
```bash
sudo dnf install -y webkit2gtk4.1 libvpx
```

---

## Download

Die neueste Version herunterladen:
**[GitHub Releases — phash/screenie](https://github.com/phash/screenie/releases)**

Verfügbare Formate: `.AppImage`, `.deb`, `.rpm`

---

## Installation per .deb (Debian/Ubuntu)

```bash
# Datei herunterladen (Version anpassen)
wget https://github.com/phash/screenie/releases/latest/download/screenie_0.1.0_amd64.deb

# Installieren
sudo dpkg -i screenie_0.1.0_amd64.deb

# Falls Abhängigkeiten fehlen:
sudo apt-get install -f
```

Starten: `screenie` oder über das Anwendungsmenü.

---

## Installation per .rpm (Fedora/RHEL)

```bash
# Datei herunterladen
wget https://github.com/phash/screenie/releases/latest/download/screenie-0.1.0-1.x86_64.rpm

# Installieren
sudo rpm -i screenie-0.1.0-1.x86_64.rpm
# oder
sudo dnf localinstall screenie-0.1.0-1.x86_64.rpm
```

---

## Installation per AppImage

```bash
# AppImage herunterladen
wget https://github.com/phash/screenie/releases/latest/download/screenie_0.1.0_amd64.AppImage

# Ausführbar machen
chmod +x screenie_0.1.0_amd64.AppImage

# Ausführen
./screenie_0.1.0_amd64.AppImage

# Optional: Systemweit verfügbar machen
sudo ln -sf "$(pwd)/screenie_0.1.0_amd64.AppImage" /usr/local/bin/screenie
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
tar -xzf screenie-linux-x86_64.tar.gz

# Binary installieren
sudo install -m 755 screenie /usr/local/bin/screenie

# Desktop-Eintrag (optional)
sudo install -m 644 screenie.desktop /usr/share/applications/screenie.desktop

# Icon (optional)
sudo install -m 644 screenie.png /usr/share/pixmaps/screenie.png

# Desktop-Datenbank aktualisieren
sudo update-desktop-database /usr/share/applications/ 2>/dev/null || true
```

---

## Erstmaliger Start

Beim ersten Start erscheint auf **Wayland** ein Screen-Capture-Portal-Dialog — dieser muss
bestätigt werden, damit Screenie Zugriff auf den Bildschirm erhält. Der Dialog erscheint
nur einmal (Berechtigung wird gespeichert).

Auf **X11** ist keine zusätzliche Berechtigung notwendig.

Screenie startet und zeigt einen 9-stelligen Code an. Diesen Code gibst du dem Helfer,
der ihn unter `https://screenie.mr-development.de` eingibt.

---

## Update

### Per .deb / .rpm

Neue Version herunterladen und mit demselben Befehl installieren — dpkg/rpm ersetzen die alte
Version automatisch.

```bash
# .deb
sudo dpkg -i screenie_NEUVERSION_amd64.deb

# .rpm
sudo rpm -U screenie-NEUVERSION-1.x86_64.rpm
```

### Per AppImage

Alte AppImage löschen, neue herunterladen und ausführbar machen. Falls du einen Symlink
angelegt hast, diesen aktualisieren:

```bash
sudo ln -sf "$(pwd)/screenie_NEUVERSION_amd64.AppImage" /usr/local/bin/screenie
```

---

## Deinstallation

### Per .deb

```bash
sudo dpkg -r screenie
# oder vollständig inkl. Konfiguration:
sudo dpkg --purge screenie
```

### Per .rpm

```bash
sudo rpm -e screenie
# oder
sudo dnf remove screenie
```

### Per AppImage / Manuell

```bash
sudo rm -f /usr/local/bin/screenie
sudo rm -f /usr/share/applications/screenie.desktop
sudo rm -f /usr/share/pixmaps/screenie.png
# AppImage selbst löschen:
rm -f screenie_*.AppImage
```

### Via install-linux.sh

```bash
curl -fsSL https://raw.githubusercontent.com/phash/screenie/main/scripts/install-linux.sh | bash -s -- --uninstall
```

---

## Probleme & Hilfe

- **Issues:** [github.com/phash/screenie/issues](https://github.com/phash/screenie/issues)
- **Schwarzer Bildschirm auf Wayland:** Screen-Capture-Portal-Dialog bestätigen oder in X11-Session wechseln
- **Verbindung schlägt fehl:** TURN-Fallback ist aktiviert; Firewall auf UDP-Ports 3478/5349 prüfen
