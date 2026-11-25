import { defineProgramPackage, type ProgramCatalog } from "@waffle-os/runtime/programs";

/** Where the language server is installed. It takes no flags and speaks LSP over stdin and stdout. */
export const TSRS_LSP_PATH = "/usr/bin/tsrs-lsp";

/**
 * tsrs's language server as a Waffle program: one wasm32-wasip1 command with TypeScript's `lib.*.d.ts` files
 * embedded, so nothing else is installed. It reads the project through the runtime root preopen.
 */
export const tsrsLsp: ProgramCatalog = defineProgramPackage({
  name: "tsrs-lsp",
  programs: [{ path: TSRS_LSP_PATH, wasm: new URL("../dist/tsrs-lsp.wasm", import.meta.url) }],
});
