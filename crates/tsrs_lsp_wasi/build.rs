// Linker settings for wasm targets; a native build links as usual.
// - The shadow stack of tsrs_wasm (crates/tsrs_wasm/build.rs, notes/wasm-build.md): the same checker runs here.
// - A declared memory maximum. Without one the module declares 4 GiB, and a host that reserves or budgets the
//   declared maximum up front counts all of it. 1 GiB holds the largest measured tsrs-wasm project (drizzle-orm,
//   537 MiB peak with the shadow stack, notes/wasm-build.md) with room to spare.

const STACK_SIZE: u64 = 80 << 20;
const MAX_MEMORY: u64 = 1 << 30;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let family = std::env::var("CARGO_CFG_TARGET_FAMILY").unwrap_or_default();
    if family.split(',').any(|f| f == "wasm") {
        println!("cargo:rustc-link-arg-bins=-zstack-size={STACK_SIZE}");
        println!("cargo:rustc-link-arg-bins=--max-memory={MAX_MEMORY}");
    }
}
