# Auffi auf Windows installieren

Diese Anleitung beschreibt zwei Wege:

1. **End-User:** Die **Auffi Sharer-App** über das fertige `.msi`/`.exe` aus dem Release.
2. **Entwickler:** Den Sharer aus dem Quellcode bauen (z. B. um an Issues wie [#85](https://github.com/phash/auffi/issues/85) zu arbeiten).

Der **Viewer** (Helfer-Seite) benötigt keine Installation — Browser öffnen und
`https://auffi.app` aufrufen.

---

## End-User-Installation

Alle Binaries werden direkt von `https://auffi.app/download/` gehostet — kein
GitHub-Account, keine Drittanbieter.

**[https://auffi.app/download/](https://auffi.app/download/)**

Verfügbare Windows-Formate: `.msi` (Windows Installer) und `.exe` (NSIS Setup).
Aktuelle Version steht in `https://auffi.app/download/latest.txt`.

### Per .msi

1. `auffi_<version>_x64_en-US.msi` herunterladen.
2. Doppelklick → Windows Installer führt durch.
3. Auffi startet aus dem Startmenü oder über `auffi.exe`.

### Per .exe (NSIS)

1. `auffi_<version>_x64-setup.exe` herunterladen.
2. Doppelklick → klassischer Setup-Assistent.

Beim ersten Start fragt Auffi nach dem Bildschirm, der freigegeben werden soll —
über den in-App-Picker (Windows Graphics Capture / xcap-Backend, keine Portal-
oder Berechtigungs-Dialoge zusätzlich).

---

## Aus dem Quellcode bauen (Entwicklung)

### Voraussetzungen

| Komponente | Zweck | Quelle |
|---|---|---|
| Windows 10 1903+ / Windows 11 | Windows Graphics Capture API | OS |
| Visual Studio 2022 (Community reicht) mit "Desktop development with C++" | MSVC-Toolchain, Windows SDK, CMake | [visualstudio.microsoft.com](https://visualstudio.microsoft.com/) |
| WebView2 Runtime | Tauri-Webview | Bei Win11 vorinstalliert |
| Rust stable (1.84+) `x86_64-pc-windows-msvc` | Sharer-Backend | [rustup.rs](https://rustup.rs/) |
| Node.js 20+ + npm | Sharer-Frontend, Viewer | [nodejs.org](https://nodejs.org/) |
| Git | Sourcen + vcpkg | [git-scm.com](https://git-scm.com/) |
| **vcpkg (classic mode)** + `libvpx:x64-windows-static-md` | VP8 Encoder (FFI) | Siehe unten |

### vcpkg + libvpx einrichten

> **Achtung:** Der mit Visual Studio 2022 gebündelte vcpkg unter
> `…\VC\vcpkg\vcpkg.exe` läuft **nur im Manifest-Mode** (sucht eine
> `vcpkg.json` im CWD). Die Rust-`vcpkg`-Crate erwartet aber den klassischen
> Modus mit zentral installierten Bibliotheken. Daher: frischen vcpkg klonen.

```powershell
git clone --depth 1 https://github.com/microsoft/vcpkg.git E:\vcpkg
& 'E:\vcpkg\bootstrap-vcpkg.bat' -disableMetrics
$env:VCPKG_ROOT = 'E:\vcpkg'
& 'E:\vcpkg\vcpkg.exe' install 'libvpx:x64-windows-static-md'
```

Pfad `E:\vcpkg` ist nur eine Empfehlung — wichtig ist, dass `VCPKG_ROOT`
dorthin zeigt und der User-Account in dem Verzeichnis schreiben darf
(`C:\Program Files\…` würde Admin-Rechte erzwingen). Der erste Install
braucht ~3–15 min je nach Binary-Cache-Treffer.

Triplet `x64-windows-static-md` (CRT-dynamic + lib-static) ist Pflicht — passt
zum MSVC-Runtime-Modus den Tauri standardmäßig nutzt; reines `static` triggert
beim Linken einen `LNK2038`.

### Build-Environment setzen

Diese zwei Environment-Variablen müssen in **jeder** Shell aktiv sein, aus der
`cargo` oder `npm run tauri:*` gestartet wird:

```powershell
$env:VCPKG_ROOT = 'E:\vcpkg'
$env:VCPKGRS_TRIPLET = 'x64-windows-static-md'
```

Damit sie persistent verfügbar sind:

```powershell
[System.Environment]::SetEnvironmentVariable('VCPKG_ROOT', 'E:\vcpkg', 'User')
[System.Environment]::SetEnvironmentVariable('VCPKGRS_TRIPLET', 'x64-windows-static-md', 'User')
```

(Nach dem Setzen alle Shells / VS Code neu starten, damit `$env:…` befüllt ist.)

### Repo + Build

```powershell
git clone https://github.com/phash/auffi.git
cd auffi\sharer
npm install
npm run tauri:dev    # nativer Window-Build + DevTools
# bzw. fürs Release-Bundle:
npm run tauri:build  # .msi + .exe nach src-tauri\target\release\bundle\
```

Lints + Tests (vor jedem Commit, per CLAUDE.md "Definition of Done"):

```powershell
cd auffi\sharer\src-tauri
cargo clippy --lib --tests -- -D warnings
cargo test --lib
```

---

## Bekannte Stolpersteine

- **`libvpx not found via vcpkg`** beim ersten `cargo build`: `VCPKG_ROOT`
  zeigt auf einen vcpkg ohne Classic-Mode-Install (typischer Fall: VS-bundle).
  Frisch klonen, siehe oben.
- **`LNK2038: mismatch detected for 'RuntimeLibrary'`**: falsches Triplet
  installiert. Es muss `x64-windows-static-md` sein (nicht `x64-windows`,
  nicht `x64-windows-static`).
- **Diagnose-Logs unsichtbar:** `println!`/`eprintln!` aus Tauri-Commands
  werden von `tauri-cli` weggeschluckt. Stattdessen `dbg_log()`-Helper aus
  `sharer/src-tauri/src/lib.rs` benutzen — schreibt nach
  `%TEMP%\auffi-debug.log`. Tail z. B. mit
  `Get-Content $env:TEMP\auffi-debug.log -Wait`.
- **Mehrere Monitore + Switch:** Issue [#85](https://github.com/phash/auffi/issues/85)
  dokumentiert den Verifikationsstand des mid-stream Monitor-Wechsels auf der
  xcap-Backend-Seite.

---

## Probleme & Hilfe

- **Issues:** [github.com/phash/auffi/issues](https://github.com/phash/auffi/issues)
- **Connection failed:** TURN-Fallback ist aktiv; Firewall auf UDP 3478/5349 prüfen.
- **Schwarzer Bildschirm beim Capture:** Sicherstellen, dass kein
  Exclusive-Fullscreen-Spiel oder DRM-Protected-Content den Monitor blockiert
  (Windows Graphics Capture ignoriert diese Quellen).
