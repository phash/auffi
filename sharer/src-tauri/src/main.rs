// Suppress the extra console window on Windows in release builds. Debug
// builds keep stdout/stderr visible for tracing capture / streaming issues.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    screenie_sharer::run();
}
