fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    link_compiler_rt();
    tauri_build::build()
}

/// ONNX Runtime's prebuilt CoreML objects call `__isPlatformVersionAtLeast` (`@available`), which
/// lives in clang's compiler-rt; rustc links with `-nodefaultlibs`, so release builds fail without it.
fn link_compiler_rt() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let Ok(output) = std::process::Command::new("xcrun").args(["clang", "--print-resource-dir"]).output() else {
        return;
    };
    let dir = std::path::PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()).join("lib/darwin");
    if dir.join("libclang_rt.osx.a").is_file() {
        println!("cargo:rustc-link-search=native={}", dir.display());
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    }
}
