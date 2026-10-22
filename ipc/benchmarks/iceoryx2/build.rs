fn main() {
    cc::Build::new().cpp(true).file("checksum.cpp").flag("-O3")
        .flag("-std=c++20").compile("shared_checksum");
    println!("cargo:rerun-if-changed=checksum.cpp");
}
