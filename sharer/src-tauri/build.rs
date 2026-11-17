fn main() {
    tauri_build::build();

    // Without this, an edit to the shim can leave the previously compiled
    // object in place: the Rust side then links a stale C function — or fails
    // with `undefined symbol` for one that was just added — and the cause is
    // invisible in the source.
    println!("cargo:rerun-if-changed=vpx_shim.c");

    let mut build = cc::Build::new();
    build.file("vpx_shim.c").flag_if_supported("-O2");

    #[cfg(windows)]
    {
        let vpx = vcpkg::Config::new().find_package("libvpx").expect(
            "libvpx not found via vcpkg — install libvpx:x64-windows-static-md and set VCPKG_ROOT",
        );
        for inc in &vpx.include_paths {
            build.include(inc);
        }
        // `find_package` already emitted the cargo:rustc-link-lib lines for
        // libvpx and its transitive deps — nothing more to do here.
    }

    #[cfg(not(windows))]
    let compiler = build.get_compiler();

    build.compile("vpx_shim");

    #[cfg(not(windows))]
    link_vpx_unix(&compiler);
}

/// Links libvpx statically when the static archive is installed.
///
/// libvpx changes its soname almost every release (Debian 12 ships .so.7,
/// Ubuntu 24.04 .so.9, Ubuntu 26.04 .so.12), so a dynamically linked .deb
/// only starts on the distro it was built on. The release build therefore
/// has to embed it; `.github/workflows/build-sharer.yml` fails the build if
/// the binary still lists libvpx as NEEDED. Dev hosts without the archive
/// (Arch strips static libs) fall back to the shared library.
///
/// The archive is located by asking the C compiler, not pkg-config: Debian's
/// vpx.pc claims `libdir=/usr/lib` while the archive sits in the multiarch
/// directory.
#[cfg(not(windows))]
fn link_vpx_unix(compiler: &cc::Tool) {
    let archive = compiler
        .to_command()
        .arg("-print-file-name=libvpx.a")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| std::path::PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()))
        .filter(|path| path.is_absolute() && path.is_file());
    match archive.as_deref().and_then(std::path::Path::parent) {
        Some(dir) => {
            println!("cargo:rustc-link-search=native={}", dir.display());
            println!("cargo:rustc-link-lib=static=vpx");
        }
        None => {
            println!(
                "cargo:warning=libvpx.a not found, linking libvpx dynamically; \
                 the binary then only runs where the same libvpx soname exists"
            );
            println!("cargo:rustc-link-lib=vpx");
        }
    }
}
