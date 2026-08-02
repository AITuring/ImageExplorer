fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("native/quicklook_thumbnail.m")
            .flag("-fobjc-arc")
            .flag("-Wno-deprecated-declarations")
            .compile("imageexplorer_quicklook_thumbnail");

        println!("cargo:rustc-link-lib=framework=QuickLook");
        println!("cargo:rustc-link-lib=framework=CoreImage");
        println!("cargo:rustc-link-lib=framework=ImageIO");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
    }

    println!("cargo:rerun-if-changed=native/quicklook_thumbnail.m");
    tauri_build::build()
}
