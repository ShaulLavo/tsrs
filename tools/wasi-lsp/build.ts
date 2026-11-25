// Builds `tsrs-lsp.wasm`: the language server as a single-threaded wasm32-wasip1 command (crates/tsrs_lsp_wasi).
//   node tools/wasi-lsp/build.ts [--out <file>] [--no-opt]
// Release settings follow tools/wasm/build.sh (opt-level s, fat LTO, panic = abort, wasm-opt -Os, build paths
// remapped). WASM_OPT names the wasm-opt binary (binaryen 133); --no-opt skips it for fast development builds.
// Fails when a build path is left in the module or when it imports anything outside wasi_snapshot_preview1.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const { values } = parseArgs({ options: { out: { type: "string" }, "no-opt": { type: "boolean" } } });
const root = resolve(import.meta.dirname, "../..");
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
const sysroot = execFileSync("rustc", ["--print", "sysroot"], { cwd: root, encoding: "utf8" }).trim();
const targetDir = process.env.CARGO_TARGET_DIR ?? join(root, "target");
const remaps = [
  [root, "/tsrs"],
  [join(cargoHome, "registry/src"), "/cargo"],
  [join(sysroot, "lib/rustlib/src/rust"), "/rustc"],
  [homedir(), "/home"],
];
const rustflags = remaps
  .map(([from, to]) => `--remap-path-prefix=${from}=${to}`)
  .concat(["-C", "llvm-args=-inlinehint-threshold=150"])
  .join(" ");

execFileSync("cargo", ["build", "--release", "-p", "tsrs_lsp_wasi", "--target", "wasm32-wasip1", "--locked"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    CARGO_PROFILE_RELEASE_OPT_LEVEL: "s",
    CARGO_PROFILE_RELEASE_LTO: "fat",
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1",
    CARGO_PROFILE_RELEASE_PANIC: "abort",
    CARGO_PROFILE_RELEASE_DEBUG: "false",
    CARGO_PROFILE_RELEASE_STRIP: "debuginfo",
    CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS: rustflags,
  },
});

const raw = join(targetDir, "wasm32-wasip1/release/tsrs-lsp.wasm");
const work = join(targetDir, "wasi-lsp");
mkdirSync(work, { recursive: true });
const module = join(work, "tsrs-lsp.wasm");
if (values["no-opt"]) copyFileSync(raw, module);
else {
  const features = enabledFeatures(readFileSync(raw));
  execFileSync(process.env.WASM_OPT ?? "wasm-opt", features.concat(["-Os", "--strip-debug", "--strip-producers", raw, "-o", module]), {
    stdio: "inherit",
  });
}

const bytes = readFileSync(module);
for (const [prefix] of remaps.concat([[sysroot, ""]])) {
  if (bytes.includes(Buffer.from(prefix!))) throw new Error(`${prefix} is in the module (remap-path-prefix missed it)`);
}
const foreign = WebAssembly.Module.imports(new WebAssembly.Module(new Uint8Array(bytes))).filter((entry) => entry.module !== "wasi_snapshot_preview1");
if (foreign.length) throw new Error(`unexpected imports: ${foreign.map((entry) => `${entry.module}.${entry.name}`).join(", ")}`);

const brotli = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }).length;
console.log(`tsrs-lsp.wasm raw ${bytes.length} gzip -9 ${gzipSync(bytes, { level: 9 }).length} brotli -q 11 ${brotli}`);
if (values.out) {
  mkdirSync(dirname(resolve(values.out)), { recursive: true });
  copyFileSync(module, values.out);
  console.log(`wrote ${values.out}`);
}

// wasm-opt flags for the features rustc enabled (the module's target_features section).
function enabledFeatures(wasm: Buffer): string[] {
  const section = WebAssembly.Module.customSections(new WebAssembly.Module(new Uint8Array(wasm)), "target_features")[0];
  if (!section) return [];
  const data = new Uint8Array(section);
  let offset = 0;
  const leb = () => {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = data[offset++]!;
      result |= (byte & 127) << shift;
      shift += 7;
    } while (byte & 128);
    return result;
  };
  const flags: string[] = [];
  const count = leb();
  for (let index = 0; index < count; index++) {
    const prefix = String.fromCharCode(data[offset++]!);
    const length = leb();
    const name = new TextDecoder().decode(data.subarray(offset, offset + length));
    offset += length;
    if (prefix === "+") flags.push(`--enable-${name === "nontrapping-fptoint" ? "nontrapping-float-to-int" : name}`);
  }
  return flags;
}
