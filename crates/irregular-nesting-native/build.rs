fn main() {
    napi_build::setup();

    // Expose the compile-time target triple to `src/lib.rs` so `native_capability()`
    // can report it without depending on a runtime-only source of truth.
    let target = std::env::var("TARGET").expect("TARGET must be set by cargo during build");
    println!("cargo:rustc-env=IRREGULAR_NATIVE_TARGET={target}");
}
