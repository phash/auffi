fn main() {
    tauri_build::build();

    // Compile and link the VP8 C shim.
    cc::Build::new()
        .file("vpx_shim.c")
        .flag("-O2")
        .compile("vpx_shim");

    // Link system libvpx.
    println!("cargo:rustc-link-lib=vpx");
}
