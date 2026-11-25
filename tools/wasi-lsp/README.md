# tsrs-lsp for Waffle

tsrs's language server as one single-threaded `wasm32-wasip1` command (`crates/tsrs_lsp_wasi`), with TypeScript's
`lib.*.d.ts` files embedded, packaged as a [Waffle](https://github.com/ShaulLavo/waffle) program.

## Build and test

```sh
cd tools/wasi-lsp
bun install --frozen-lockfile
WASM_OPT=/path/to/binaryen-133/wasm-opt bun run build   # dist/tsrs-lsp.wasm
bun run test:browser                                    # headless Chromium, Playwright 1.64.1
```

## Use

```ts
import { startCommand } from "@waffle-os/runtime/command";
import { TSRS_LSP_PATH, tsrsLsp } from "tsrs-lsp-wasi";

await runtime.programs.onDemand(tsrsLsp);
const server = startCommand(runtime, TSRS_LSP_PATH, {
  filesystem: "runtime-root",
  cwd: "/home/project",
  stdin, // LSP frames (Content-Length) in
  stdout: { limitBytes: 0, onChunk }, // LSP frames out
});
```

The server takes no flags. File diagnostics are pull-only (`textDocument/diagnostic`), as in TypeScript 7.
The single-thread patch and its limits are described in `notes/wasi-lsp.md`.
