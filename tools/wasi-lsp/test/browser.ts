// Runs tsrs-lsp on Waffle in headless Chromium and checks real answers through Singapore's client.
//   bun test/browser.ts [--json <file>]
// Needs dist/tsrs-lsp.wasm (`bun run build`) and Playwright's Chromium. TSRS_LSP_SCRATCH picks the scratch root
// (default: the OS temp directory). The run owns its server, browser and scratch, and removes them on every exit.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { brotliCompressSync, constants } from "node:zlib";
import { chromium, type Browser } from "playwright-core";

const HANG_CAP_MS = 180_000;
const { values } = parseArgs({ options: { json: { type: "string" } } });
const here = import.meta.dirname;
const wasmPath = resolve(here, "../dist/tsrs-lsp.wasm");
const wasm = readFileSync(wasmPath);
const scratch = mkdtempSync(join(process.env.TSRS_LSP_SCRATCH ?? tmpdir(), "tsrs-lsp-browser-"));
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;

try {
  const built = await Bun.build({
    entrypoints: [
      join(here, "page.ts"),
      Bun.resolveSync("@waffle-os/runtime/browser/fs-worker", here),
      Bun.resolveSync("@waffle-os/runtime/browser/preview1-worker", here),
    ],
    outdir: join(scratch, "www"),
    target: "browser",
    splitting: true,
    naming: { entry: "[name].js", chunk: "chunk-[hash].js", asset: "[name]-[hash].[ext]" },
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");

  const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/") {
        return new Response('<!doctype html><script type="module" src="/page.js"></script>', {
          headers: { ...isolation, "Content-Type": "text/html" },
        });
      }
      if (path.endsWith("/tsrs-lsp.wasm")) return new Response(Bun.file(wasmPath), { headers: { ...isolation, "Content-Type": "application/wasm" } });
      const file = Bun.file(join(scratch, "www", path));
      return file.exists().then((found) =>
        found ? new Response(file, { headers: isolation }) : new Response("not found", { status: 404, headers: isolation }),
      );
    },
  });

  browser = await chromium.launch({ headless: true, args: ["--enable-blink-features=ForceEagerMeasureMemory"] });
  const page = await browser.newPage();
  const console: string[] = [];
  page.on("console", (message) => void console.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => void console.push(`pageerror: ${error.message}`));
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.waitForFunction(() => window.__result !== undefined || window.__error !== undefined, null, { timeout: HANG_CAP_MS });
  const error = await page.evaluate(() => window.__error);
  if (error) throw new Error(`page failed: ${error}\n${console.join("\n")}`);
  const result = (await page.evaluate(() => window.__result)) as {
    checks: Record<string, boolean>;
    timings: { warm: Record<string, number[]> };
  };

  const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
  const brotliBytes = brotliCompressSync(wasm, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: wasm.length } }).length;
  const report = {
    ...result,
    medians: Object.fromEntries(Object.entries(result.timings.warm).map(([name, samples]) => [name, median(samples)])),
    transfer: { wasmRawBytes: wasm.length, wasmBrotliBytes: brotliBytes },
  };
  if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  const failed = Object.entries(result.checks).filter(([, passed]) => !passed);
  if (failed.length) throw new Error(`failed checks: ${failed.map(([name]) => name).join(", ")}`);
  process.stdout.write(`all ${Object.keys(result.checks).length} checks passed\n`);
} finally {
  await browser?.close();
  await server?.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}
