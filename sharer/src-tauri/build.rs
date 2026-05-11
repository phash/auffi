fn main() {
    tauri_build::build();

    let mut build = cc::Build::new();
    build.file("vpx_shim.c").flag_if_supported("-O2");

    #[cfg(windows)]
    {
        let vpx = vcpkg::Config::new()
            .find_package("libvpx")
            .expect("libvpx not found via vcpkg — install libvpx:x64-windows-static-md and set VCPKG_ROOT");
        for inc in &vpx.include_paths {
            build.include(inc);
        }
        // `find_package` already emitted the cargo:rustc-link-lib lines for
        // libvpx and its transitive deps — nothing more to do here.
    }

    build.compile("vpx_shim");

    #[cfg(not(windows))]
    println!("cargo:rustc-link-lib=vpx");
}
