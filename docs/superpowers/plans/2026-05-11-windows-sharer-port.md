# Windows Sharer Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the screenie sharer build and run on Windows 11 by replacing the X11-only screen-capture backend with a cross-platform one and linking libvpx via vcpkg, so a user on Windows can ask for help by running the sharer .exe.

**Architecture:** Unify screen capture on the cross-platform `xcap` crate (replaces `x11rb`, works on Linux + Windows + macOS) — no `cfg(target_os)` split in the capture module, per CLAUDE.md "eine Lösung wählen, nicht zwei". For the libvpx FFI link, keep the C shim and the `cargo:rustc-link-lib=vpx` line only on Unix; on Windows use the `vcpkg` build-helper crate to discover the static `libvpx` installed via vcpkg.

**Tech Stack:**
- xcap = 0.9.4 (replaces x11rb; cross-platform screen + monitor enumeration, RGBA pull-based)
- vcpkg = 0.2.15 (Cargo build-helper to locate libvpx via VCPKG_ROOT)
- vcpkg port: `libvpx:x64-windows-static-md` (CRT-dynamic, lib-static — matches Tauri's default MSVC runtime)
- Rust stable-x86_64-pc-windows-msvc (1.84+; we install latest stable)
- Existing: Tauri 2.11.1, webrtc 0.8.0, enigo 0.6.1 (already cross-platform)
- Existing on host: MSVC 2022, WebView2 147, CMake — only Rust + libvpx are missing

**Out of scope (explicit non-goals):**
- macOS support — xcap supports it but we don't build/test there.
- Wayland-native capture — xcap already handles X11 + Wayland (best-effort) on Linux.
- Code-signing the Windows binary — not required for local self-use.
- CI: this plan does NOT touch `.github/workflows/build-sharer.yml`. A follow-up commit can validate the Windows job once we know the local build works.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `sharer/src-tauri/src/capture.rs` | **Rewrite** | xcap-based pull capture, BGRA frames, monitor enumeration. Linux + Windows. |
| `sharer/src-tauri/build.rs` | **Modify** | Branch on `target_family`: Unix → existing `rustc-link-lib=vpx`; Windows → `vcpkg::Config::new().find_package("libvpx")`. |
| `sharer/src-tauri/Cargo.toml` | **Modify** | Remove `x11rb`; add `xcap = "=0.9.4"`; add `[target.'cfg(windows)'.build-dependencies] vcpkg = "=0.2.15"`. |
| `sharer/src-tauri/vpx_shim.c` | **Keep unchanged** | The C shim is portable; compiles via `cc` crate on both platforms. |
| `sharer/src-tauri/src/encoder.rs` | **Keep unchanged** | Already pulls in BGRA → I420 internally; no platform dep. |
| `sharer/src-tauri/src/input.rs` | **Keep unchanged** | enigo is cross-platform. |
| `sharer/src-tauri/src/lib.rs` | **Keep unchanged** | Public API of `capture` module stays the same (`list_displays`, `ScreenCapturer::start`, `next_frame`, `width`, `height`, `DisplayInfo`). |
| `INSTALL-WINDOWS.md` | **Create** | Setup notes for Windows users running from source. |

**Public API of `capture` module that must not break:**

```rust
pub struct DisplayInfo { pub id: u32, pub title: String, pub x: i32, pub y: i32, pub width: u32, pub height: u32 }
pub struct BgraFrame { pub data: Vec<u8>, pub pts_us: u64 }
pub struct ScreenCapturer { /* private */ }
pub fn list_displays() -> Vec<DisplayInfo>;
impl ScreenCapturer {
    pub fn start(display_id: u32) -> Result<Self, String>;
    pub fn next_frame(&mut self) -> Result<BgraFrame, String>;
    pub fn width(&self) -> u32;
    pub fn height(&self) -> u32;
}
```

All other files in `sharer/src-tauri/src/` reference the module only via these symbols — verified by grepping `capture::` across the tree.

---

### Task 1: Install Rust toolchain (Windows)

**Files:** none — host setup only.

- [ ] **Step 1: Download rustup-init.exe and install stable-MSVC**

Run in PowerShell:

```powershell
Invoke-WebRequest -Uri https://win.rustup.rs/x86_64 -OutFile $env:TEMP\rustup-init.exe
& $env:TEMP\rustup-init.exe -y --default-toolchain stable --default-host x86_64-pc-windows-msvc --profile default
```

Expected: rustup-init installs cargo, rustc, clippy, rustfmt to `%USERPROFILE%\.cargo\bin`. Exit code 0.

- [ ] **Step 2: Verify toolchain on the current shell**

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
cargo --version
rustc --version
```

Expected: both print versions ≥ 1.84.

- [ ] **Step 3: Sanity-check linker**

```powershell
rustc --print target-libdir
```

Expected: a path under `…\rustlib\x86_64-pc-windows-msvc\lib`. If `rustc` errors with `linker 'link.exe' not found`, the MSVC env isn't on PATH — fix by running from a "Developer PowerShell for VS 2022" or by adding `C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\<ver>\bin\Hostx64\x64` to PATH for this session.

No commit (host install).

---

### Task 2: Install libvpx via vcpkg

**Files:** none — host setup. The vcpkg install lives outside the repo.

- [ ] **Step 1: Bootstrap vcpkg (already installed under VS2022)**

```powershell
$vcpkg = 'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\vcpkg'
& "$vcpkg\bootstrap-vcpkg.bat"
```

Expected: `vcpkg.exe` exists at `$vcpkg\vcpkg.exe`. No reinstall if already bootstrapped.

- [ ] **Step 2: Install libvpx for x64-windows-static-md**

```powershell
& "$vcpkg\vcpkg.exe" install "libvpx:x64-windows-static-md"
```

Expected: build runs ~5-15 min, ends with `Total install time: …` and a line `libvpx:x64-windows-static-md was successfully installed`.

Why static-md (not pure static): Tauri builds use the MSVC dynamic CRT by default; mixing pure-static libvpx with dynamic CRT triggers LNK2038. The `-md` suffix means lib is statically linked but the C runtime is dynamic — matches Tauri.

- [ ] **Step 3: Export VCPKG_ROOT + VCPKGRS_TRIPLET for the build session**

```powershell
$env:VCPKG_ROOT = 'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\vcpkg'
$env:VCPKGRS_TRIPLET = 'x64-windows-static-md'
```

Document these in INSTALL-WINDOWS.md (Task 7) so future builds reproduce.

No commit.

---

### Task 3: Add the `xcap` dependency and a failing test

**Files:**
- Modify: `sharer/src-tauri/Cargo.toml`
- Test: `sharer/src-tauri/src/capture.rs` (tests module)

- [ ] **Step 1: Add the dependency (without removing x11rb yet — TDD: write failing test first against new behaviour)**

Edit `sharer/src-tauri/Cargo.toml`:

```toml
xcap = "=0.9.4"
```

(Inserted alphabetically into `[dependencies]`. We keep `x11rb` for one commit to keep the existing tree green.)

- [ ] **Step 2: Write a failing test that asserts capture is xcap-backed**

Add to the `tests` module at the bottom of `sharer/src-tauri/src/capture.rs`:

```rust
#[test]
fn list_displays_uses_xcap_monitor_count() {
    // Sanity-check: our list_displays() must agree with xcap's monitor enumeration.
    // Once the migration is complete, list_displays() returns the same count as
    // xcap::Monitor::all() — this test fails today because list_displays() uses
    // x11rb on Linux and panics with "Cannot connect to X server" on Windows.
    let displays = list_displays();
    let xcap_count = xcap::Monitor::all().map(|m| m.len()).unwrap_or(0);
    assert_eq!(displays.len(), xcap_count, "list_displays() must mirror xcap monitor count");
}
```

- [ ] **Step 3: Run the test, see it fail**

```powershell
cd sharer/src-tauri
cargo test --lib list_displays_uses_xcap_monitor_count
```

Expected on Windows: compile fails because `x11rb` cannot link (the Windows backend of x11rb needs an X server). Alternatively the test runs and asserts on different counts. Either way: red.

- [ ] **Step 4: Commit (failing test only, no impl yet — TDD discipline)**

```powershell
git add sharer/src-tauri/Cargo.toml sharer/src-tauri/src/capture.rs
git commit -m "test(sharer): add xcap-backed capture invariant (failing)"
```

If pre-commit hooks complain about the test failing — that is intended for this single commit. Skip ONLY by passing `--allow-empty` if literally nothing else changed; otherwise the commit goes through (failing tests do not block git, only CI).

---

### Task 4: Rewrite `capture.rs` on top of xcap

**Files:**
- Rewrite: `sharer/src-tauri/src/capture.rs`

- [ ] **Step 1: Replace the module body**

Full new file content of `sharer/src-tauri/src/capture.rs`:

```rust
use std::sync::mpsc;

use xcap::Monitor;

#[derive(Debug, Clone, serde::Serialize)]
pub struct DisplayInfo {
    pub id: u32,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Returns all capturable monitors via xcap.
///
/// Returns a single fallback entry only when xcap cannot enumerate monitors
/// at all — keeps the UI populated so the user sees an error instead of an
/// empty list.
pub fn list_displays() -> Vec<DisplayInfo> {
    let monitors = match Monitor::all() {
        Ok(ms) if !ms.is_empty() => ms,
        _ => {
            return vec![DisplayInfo {
                id: 0,
                title: "Primary Display".to_string(),
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            }];
        }
    };

    monitors
        .into_iter()
        .enumerate()
        .map(|(idx, m)| DisplayInfo {
            id: idx as u32,
            title: m.name().unwrap_or_default(),
            x: m.x().unwrap_or(0),
            y: m.y().unwrap_or(0),
            width: m.width().unwrap_or(0),
            height: m.height().unwrap_or(0),
        })
        .collect()
}

/// A single BGRA video frame captured from the screen.
pub struct BgraFrame {
    pub data: Vec<u8>,
    pub pts_us: u64,
}

/// An active screen capture session, sending frames over a channel.
pub struct ScreenCapturer {
    rx: mpsc::Receiver<BgraFrame>,
    _stop_tx: mpsc::SyncSender<()>,
    frame_width: u32,
    frame_height: u32,
}

impl ScreenCapturer {
    /// Start capturing the monitor identified by `display_id` (index into `list_displays`).
    pub fn start(display_id: u32) -> Result<Self, String> {
        let monitors = Monitor::all().map_err(|e| e.to_string())?;
        let monitor = monitors
            .into_iter()
            .nth(display_id as usize)
            .ok_or_else(|| format!("monitor index {display_id} not found"))?;

        let width = monitor.width().map_err(|e| e.to_string())?;
        let height = monitor.height().map_err(|e| e.to_string())?;

        let (tx, rx) = mpsc::sync_channel::<BgraFrame>(2);
        let (stop_tx, stop_rx) = mpsc::sync_channel::<()>(1);

        std::thread::Builder::new()
            .name("screen-capture".to_string())
            .spawn(move || {
                let interval = std::time::Duration::from_millis(33);
                let start = std::time::Instant::now();
                loop {
                    if stop_rx.try_recv().is_ok() {
                        break;
                    }

                    let pts_us = start.elapsed().as_micros() as u64;

                    let image = match monitor.capture_image() {
                        Ok(img) => img,
                        Err(_) => break,
                    };

                    let bgra = rgba_to_bgra(image.into_raw());
                    if tx.try_send(BgraFrame { data: bgra, pts_us }).is_err() {
                        // Receiver full or dropped; drop frame.
                    }

                    std::thread::sleep(interval);
                }
            })
            .map_err(|e| e.to_string())?;

        Ok(Self {
            rx,
            _stop_tx: stop_tx,
            frame_width: width,
            frame_height: height,
        })
    }

    pub fn next_frame(&mut self) -> Result<BgraFrame, String> {
        self.rx.recv().map_err(|e| e.to_string())
    }

    pub fn width(&self) -> u32 {
        self.frame_width
    }

    pub fn height(&self) -> u32 {
        self.frame_height
    }
}

/// Convert RGBA (xcap output) into BGRA (libvpx input).
fn rgba_to_bgra(mut data: Vec<u8>) -> Vec<u8> {
    for px in data.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_displays_returns_at_least_one() {
        let displays = list_displays();
        assert!(!displays.is_empty(), "expected at least one display entry");
    }

    #[test]
    fn list_displays_uses_xcap_monitor_count() {
        let displays = list_displays();
        let xcap_count = xcap::Monitor::all().map(|m| m.len()).unwrap_or(0);
        if xcap_count == 0 {
            assert_eq!(displays.len(), 1, "fallback path must give exactly one entry");
        } else {
            assert_eq!(displays.len(), xcap_count, "list_displays() must mirror xcap");
        }
    }

    #[test]
    fn display_info_serializes_to_json() {
        let info = DisplayInfo {
            id: 1,
            title: "Test Display".to_string(),
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let json = serde_json::to_string(&info).expect("serialize DisplayInfo");
        assert!(json.contains("\"id\":1"));
        assert!(json.contains("\"title\":\"Test Display\""));
    }

    #[test]
    fn display_info_json_contains_expected_keys() {
        let info = DisplayInfo {
            id: 0,
            title: "Primary Display".to_string(),
            x: 1920,
            y: 0,
            width: 2560,
            height: 1440,
        };
        let val: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&info).unwrap()).unwrap();
        assert_eq!(val["id"], 0);
        assert_eq!(val["title"], "Primary Display");
        assert_eq!(val["x"], 1920);
        assert_eq!(val["y"], 0);
        assert_eq!(val["width"], 2560);
        assert_eq!(val["height"], 1440);
    }

    #[test]
    fn rgba_to_bgra_swaps_channels() {
        let rgba = vec![0x10, 0x20, 0x30, 0xff, 0x40, 0x50, 0x60, 0xee];
        let bgra = rgba_to_bgra(rgba);
        assert_eq!(bgra, vec![0x30, 0x20, 0x10, 0xff, 0x60, 0x50, 0x40, 0xee]);
    }

    #[test]
    fn rgba_to_bgra_preserves_alpha() {
        let rgba = vec![0xaa, 0xbb, 0xcc, 0x7f];
        let bgra = rgba_to_bgra(rgba);
        assert_eq!(bgra[3], 0x7f, "alpha channel must be untouched");
    }
}
```

- [ ] **Step 2: Remove `x11rb` from `Cargo.toml`**

Edit `sharer/src-tauri/Cargo.toml` and delete the line:

```toml
x11rb = { version = "=0.13.2", features = ["randr", "render", "shm", "image"] }
```

- [ ] **Step 3: Build (host build, no Tauri yet)**

```powershell
cd sharer/src-tauri
$env:VCPKG_ROOT = 'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\vcpkg'
$env:VCPKGRS_TRIPLET = 'x64-windows-static-md'
cargo check
```

Expected: compiles. There may be one or two cargo warnings — fix them inline if they appear (unused imports etc.). The build will fail at libvpx-link step if Task 5 isn't done yet; running just `cargo check` (no `--all-targets`) typechecks without linking, so it should pass.

If `cargo check` succeeds: tests can be run after Task 5 (which fixes the libvpx link).

- [ ] **Step 4: Commit**

```powershell
git add sharer/src-tauri/Cargo.toml sharer/src-tauri/src/capture.rs
git commit -m "refactor(sharer): replace x11rb with xcap for cross-platform capture"
```

---

### Task 5: Cross-platform libvpx link via vcpkg

**Files:**
- Modify: `sharer/src-tauri/build.rs`
- Modify: `sharer/src-tauri/Cargo.toml`

- [ ] **Step 1: Add `vcpkg` to build-dependencies (Windows only)**

Edit `sharer/src-tauri/Cargo.toml`. Find the `[build-dependencies]` section and add a Windows-only target table at the end of the file:

```toml
[build-dependencies]
tauri-build = { version = "=2.6.1", features = [] }
cc = "=1.2.25"

[target.'cfg(windows)'.build-dependencies]
vcpkg = "=0.2.15"
```

- [ ] **Step 2: Rewrite `build.rs`**

Replace `sharer/src-tauri/build.rs` content:

```rust
fn main() {
    tauri_build::build();

    cc::Build::new()
        .file("vpx_shim.c")
        .flag_if_supported("-O2")
        .compile("vpx_shim");

    link_libvpx();
}

#[cfg(windows)]
fn link_libvpx() {
    // vcpkg integration: requires VCPKG_ROOT env var and a triplet (default
    // x64-windows-static-md). The vcpkg crate emits all rustc-link-lib lines
    // needed to satisfy libvpx + its transitive deps (pthread-stub etc.).
    let lib = vcpkg::Config::new()
        .find_package("libvpx")
        .expect("libvpx not found via vcpkg — set VCPKG_ROOT and install libvpx:x64-windows-static-md");
    // The vcpkg-emitted include path is needed by cc::Build above on subsequent
    // edits; for now vpx_shim.c includes are resolved via VS-installed SDK
    // headers — if cc fails to find <vpx/vpx_encoder.h>, uncomment:
    let _ = lib; // suppress unused warning when no additional cc::Build use
}

#[cfg(not(windows))]
fn link_libvpx() {
    println!("cargo:rustc-link-lib=vpx");
}
```

- [ ] **Step 3: Add vcpkg include path to the cc build (Windows)**

The C shim `#include <vpx/vpx_encoder.h>` needs vcpkg's `include` dir. Update the `cc::Build` invocation to inject vcpkg's include path on Windows:

Replace the top of `main()`:

```rust
fn main() {
    tauri_build::build();

    let mut build = cc::Build::new();
    build.file("vpx_shim.c").flag_if_supported("-O2");

    #[cfg(windows)]
    {
        let vpx = vcpkg::Config::new()
            .find_package("libvpx")
            .expect("libvpx not found via vcpkg — install libvpx:x64-windows-static-md");
        for inc in &vpx.include_paths {
            build.include(inc);
        }
    }

    build.compile("vpx_shim");

    #[cfg(not(windows))]
    println!("cargo:rustc-link-lib=vpx");
}
```

(The library link on Windows is handled by `find_package` — it already emits the `rustc-link-lib` lines. No `println!` on Windows.)

- [ ] **Step 4: Run cargo check + test**

```powershell
$env:VCPKG_ROOT = 'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\vcpkg'
$env:VCPKGRS_TRIPLET = 'x64-windows-static-md'
cargo test --lib
```

Expected: builds, links libvpx from vcpkg, all tests pass including the encoder tests (`encoder_new_succeeds`, `encode_solid_color_frame_produces_packets`).

If link fails with `unresolved external symbol __imp_…`: triplet mismatch. Verify with `vcpkg list libvpx` that the installed triplet is exactly `x64-windows-static-md`.

- [ ] **Step 5: Commit**

```powershell
git add sharer/src-tauri/build.rs sharer/src-tauri/Cargo.toml
git commit -m "build(sharer): link libvpx via vcpkg on Windows, system on Unix"
```

---

### Task 6: Lint + Cargo.lock + full test suite

**Files:**
- Generated: `sharer/src-tauri/Cargo.lock`

- [ ] **Step 1: Clippy with deny-warnings**

```powershell
cd sharer/src-tauri
cargo clippy --all-targets -- -D warnings
```

Expected: no warnings, no errors. Fix any clippy lints inline (typically unused imports after the x11rb removal).

- [ ] **Step 2: Run the full suite**

```powershell
cargo test
```

Expected: all tests pass. Capture tests run against the real Windows desktop (xcap enumerates monitors successfully).

- [ ] **Step 3: Verify Cargo.lock updated**

`git status` should show `sharer/src-tauri/Cargo.lock` modified (xcap + dependencies added, x11rb removed).

- [ ] **Step 4: Commit lockfile**

```powershell
git add sharer/src-tauri/Cargo.lock
git commit -m "chore(sharer): update Cargo.lock for xcap + vcpkg deps"
```

---

### Task 7: Document Windows setup

**Files:**
- Create: `INSTALL-WINDOWS.md`

- [ ] **Step 1: Write the install doc**

```markdown
# Screenie Sharer — Windows From Source

## Voraussetzungen

- Windows 10 1903+ oder Windows 11 (für Windows Graphics Capture via xcap)
- Visual Studio 2022 Build Tools mit C++-Workload **oder** Visual Studio 2022 Community
- WebView2 Runtime (bei Windows 11 vorinstalliert)
- Node.js ≥ 22
- Rust stable (MSVC-Toolchain)
- vcpkg (kommt mit VS2022 unter `…\Microsoft Visual Studio\2022\Community\VC\vcpkg`)

## Setup

```powershell
# Rust
Invoke-WebRequest -Uri https://win.rustup.rs/x86_64 -OutFile $env:TEMP\rustup-init.exe
& $env:TEMP\rustup-init.exe -y --default-toolchain stable --default-host x86_64-pc-windows-msvc

# vcpkg + libvpx
$vcpkg = 'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\vcpkg'
& "$vcpkg\bootstrap-vcpkg.bat"
& "$vcpkg\vcpkg.exe" install libvpx:x64-windows-static-md

# Build-Env (jedes Mal vor `cargo` / `tauri:build`)
$env:VCPKG_ROOT = $vcpkg
$env:VCPKGRS_TRIPLET = 'x64-windows-static-md'
```

## Build

```powershell
cd sharer
npm ci
$env:SCREENIE_BACKEND_WS = 'wss://screenie.mr-development.de/signal'
npm run tauri:build
```

Output: `sharer/src-tauri/target/release/bundle/msi/screenie-sharer_0.1.0_x64_en-US.msi`.
```

- [ ] **Step 2: Commit**

```powershell
git add INSTALL-WINDOWS.md
git commit -m "docs: Windows-from-source install instructions for the sharer"
```

---

### Task 8: Tauri release build → .msi

**Files:** none code-side; output artifact only.

- [ ] **Step 1: Install Node deps**

```powershell
cd sharer
npm ci
```

- [ ] **Step 2: Build the Tauri app**

```powershell
$env:VCPKG_ROOT = 'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\vcpkg'
$env:VCPKGRS_TRIPLET = 'x64-windows-static-md'
$env:SCREENIE_BACKEND_WS = 'wss://screenie.mr-development.de/signal'
npm run tauri:build
```

Expected: `target/release/bundle/msi/*.msi` + `target/release/bundle/nsis/*.exe` produced. Build time ~5-15 min first time (libvpx already cached).

- [ ] **Step 3: Verify outputs**

```powershell
Get-ChildItem sharer\src-tauri\target\release\bundle -Recurse -Filter *.msi
Get-ChildItem sharer\src-tauri\target\release\bundle -Recurse -Filter *.exe
```

Expected: at least one `.msi` and one NSIS `.exe` listed.

No commit (artifacts are gitignored).

---

### Task 9: Smoke-test against production backend

**Files:** none.

- [ ] **Step 1: Install the .msi (or run the unpacked exe)**

Run the produced `.msi` interactively, OR launch directly without install:

```powershell
& "sharer\src-tauri\target\release\screenie-sharer.exe"
```

- [ ] **Step 2: Verify the signaling URL hint**

The sharer reads `SCREENIE_BACKEND_WS` at runtime (lib.rs:50). If launched without env, it defaults to `ws://localhost:8080/signal`. For production-backend testing, set it before launch (Step 1 in PowerShell, or via a shortcut). Verify in the app log that it dials `wss://screenie.mr-development.de/signal`.

- [ ] **Step 3: Hand-off the code to a second browser**

On a second device (or even in incognito mode here), open `https://screenie.mr-development.de`, enter the 9-digit code displayed by the sharer, accept the prompt on the sharer side, and verify the screen stream appears.

- [ ] **Step 4: Verify the streaming path**

The sharer UI emits a `connection-type` event (lib.rs:188-214) — observe in the sharer UI whether the connection is `p2p` or `relay`. For a same-network test it should be `p2p`. For cross-network it may fall back to `relay` (TURN).

If video shows up: ✅ DONE. If not: capture logs from the sharer (`%APPDATA%\com.screenie.sharer\logs\` if Tauri logging is configured, otherwise the console).

---

## Self-Review

**Spec coverage:**
- ✅ Replace X11-only capture → Task 4 (xcap unified backend)
- ✅ Provide libvpx on Windows → Tasks 2 + 5 (vcpkg integration)
- ✅ Install Rust → Task 1
- ✅ Build the .exe → Task 8
- ✅ Connect from another PC → Task 9 (production-backend smoke test, viewer at screenie.mr-development.de)
- ✅ Tests pass / clippy clean / CLAUDE.md rules → Task 6

**No placeholders:** Every step has full code or a runnable command. The only "may need uncomment" remark is in Task 5 Step 3 where we already extended the cc::Build for vcpkg includes — verified the snippet is complete.

**Type consistency:** Public API of `capture` module unchanged (`DisplayInfo`, `BgraFrame`, `ScreenCapturer`, `list_displays`, `start`, `next_frame`, `width`, `height`). No callers in `lib.rs`/`encoder.rs` need to change.

**One known limitation:** xcap on Linux X11 uses `xrandr` enumeration but emits frames via shm — the existing X11rb tests covered specific BGRA conversion paths that no longer apply. If a Linux user reports a regression, run the cargo test suite on Linux to confirm.
