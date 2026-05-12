//! Compares the two xcap capture paths on Windows so we can attribute the
//! ~1-2 fps regression reported in issue #88 to the right layer.
//!
//! - **Path A** mirrors the current `WindowsCapturer::start` loop in
//!   `src/capture/windows.rs`: a tight `monitor.capture_image()` poll with
//!   the result drained through `into_raw()`. Each call sets up a fresh
//!   WGC session under the hood — that's the suspected root cause.
//! - **Path B** uses `monitor.video_recorder()`, xcap's streaming/callback
//!   API. One persistent capture session, FrameArrived → mpsc.
//!
//! Run with:
//!   $env:VCPKG_ROOT='E:\vcpkg'; $env:VCPKGRS_TRIPLET='x64-windows-static-md'
//!   cargo run --example bench_capture --release
//!
//! Release build is important — debug mode skews the BGRA byte-swap cost
//! enough to confuse the comparison.

use std::time::{Duration, Instant};

fn main() {
    println!("== xcap capture path benchmark (issue #88) ==");

    let monitors = xcap::Monitor::all().expect("enumerate monitors");
    println!("found {} monitor(s)", monitors.len());
    for (i, m) in monitors.iter().enumerate() {
        let w = m.width().unwrap_or(0);
        let h = m.height().unwrap_or(0);
        let x = m.x().unwrap_or(0);
        let y = m.y().unwrap_or(0);
        println!(
            "  monitor[{i}] {}x{} @ ({},{}) name={}",
            w,
            h,
            x,
            y,
            m.name().unwrap_or_default()
        );
    }

    let m = &monitors[0];
    let w = m.width().unwrap();
    let h = m.height().unwrap();
    let bytes_per_frame = (w as u64) * (h as u64) * 4;
    println!(
        "\nbenchmarking monitor 0: {w}x{h} ({} MB/frame)",
        bytes_per_frame / 1024 / 1024
    );

    // ── Path A: capture_image() (current implementation) ────────────────
    println!("\nPath A: monitor.capture_image() loop (current src/capture/windows.rs)");
    let target_a = 30usize;
    let mut times = Vec::with_capacity(target_a);
    let t_start = Instant::now();
    for i in 0..target_a {
        let t = Instant::now();
        let img = m.capture_image().expect("capture_image failed");
        let _raw = img.into_raw();
        let elapsed = t.elapsed();
        times.push(elapsed);
        if i < 3 || i + 1 == target_a {
            println!("  frame {i}: {elapsed:?}");
        }
    }
    let total_a = t_start.elapsed();
    let avg_a = times.iter().sum::<Duration>() / target_a as u32;
    let fps_a = target_a as f64 / total_a.as_secs_f64();
    println!(
        "Path A total: {target_a} frames in {total_a:?} → {fps_a:.2} fps, avg per-frame {avg_a:?}"
    );

    // ── Path B: video_recorder() streaming API ──────────────────────────
    println!("\nPath B: monitor.video_recorder() streaming (issue #88 proposed fix)");
    let (rec, rx) = m
        .video_recorder()
        .expect("video_recorder construction failed");
    rec.start().expect("video_recorder start failed");

    // Drop the first frame — capture sessions often take a few ms to
    // ramp up and the first arrival is not representative of steady-state.
    let _warmup = rx.recv_timeout(Duration::from_secs(2)).ok();

    let bench_dur = Duration::from_secs(3);
    let t_start = Instant::now();
    let mut count = 0u64;
    while t_start.elapsed() < bench_dur {
        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(_frame) => count += 1,
            Err(e) => {
                println!("  recv timed out / disconnected after {count} frames: {e:?}");
                break;
            }
        }
    }
    let total_b = t_start.elapsed();
    let _ = rec.stop();
    let fps_b = count as f64 / total_b.as_secs_f64();
    println!("Path B total: {count} frames in {total_b:?} → {fps_b:.2} fps");

    // ── Verdict ─────────────────────────────────────────────────────────
    println!("\n== verdict ==");
    println!("Path A: {fps_a:.2} fps");
    println!("Path B: {fps_b:.2} fps");
    let speedup = fps_b / fps_a.max(0.001);
    println!("Streaming path is {speedup:.1}× the polling path.");
    if fps_b >= 25.0 {
        println!("→ video_recorder() meets the issue-#88 acceptance threshold (≥25 fps).");
    } else {
        println!(
            "→ video_recorder() still below 25 fps — bottleneck is NOT just capture-session setup."
        );
    }
}
