// Acceptance for the whole browser IntelliSense chain as a user sees it: a Singapore editor with the language
// server adapter plugin, wired through test/sprockt-glue.ts, talking to tsrs-lsp on Waffle in headless Chromium.
//   bun test/editor-acceptance.ts [--runs 3] [--json <file>] [--shots <dir>]
// Needs dist/tsrs-lsp.wasm (`bun run build`) and Playwright's Chromium. TSRS_LSP_SCRATCH picks the scratch root.
// Asserts outcomes only. Timings are recorded; the only time limit is a hang cap per wait.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright-core";
import { PROJECT_ROOT } from "./fixture.ts";
import type { AcceptancePage } from "./editor-page.ts";

const HANG_CAP_MS = 120_000;
const SHAPES_PATH = `${PROJECT_ROOT}/src/shapes.ts`;
const MONEY_TYPES_PATH = `${PROJECT_ROOT}/node_modules/tiny-money/index.d.ts`;
const CHECKS = ["diagnostics", "hover", "completion", "definition", "crashRestart", "dispose", "noErrorsLogged"] as const;
type CheckName = (typeof CHECKS)[number];
type RunReport = {
  run: number;
  startedWall: number;
  checks: Partial<Record<CheckName, boolean>>;
  failures: Partial<Record<CheckName, string>>;
  timings: Record<string, number>;
  details: Record<string, unknown>;
  console: string[];
};

const { values } = parseArgs({
  options: { runs: { type: "string", default: "3" }, json: { type: "string" }, shots: { type: "string" } },
});
const here = import.meta.dirname;
const wasmPath = resolve(here, "../dist/tsrs-lsp.wasm");
const scratch = mkdtempSync(join(process.env.TSRS_LSP_SCRATCH ?? tmpdir(), "tsrs-lsp-editor-"));
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;

/** Calls one page method and returns its result. */
function call<K extends keyof AcceptancePage>(
  page: Page,
  method: K,
  ...args: Parameters<AcceptancePage[K]>
): Promise<Awaited<ReturnType<AcceptancePage[K]>>> {
  return page.evaluate(
    ([name, rest]) => (window.__accept![name] as (...values: unknown[]) => unknown)(...rest),
    [method, args] as const,
  ) as Promise<Awaited<ReturnType<AcceptancePage[K]>>>;
}

/** Polls a page condition until it holds, up to the hang cap. */
async function until<T>(what: string, probe: () => Promise<T>, holds: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + HANG_CAP_MS;
  for (;;) {
    const value = await probe();
    if (holds(value)) return value;
    if (performance.now() > deadline) throw new Error(`hang cap reached waiting for ${what}; last: ${JSON.stringify(value)}`);
    await Bun.sleep(25);
  }
}

async function shot(page: Page, name: string, run: number): Promise<void> {
  if (!values.shots || run !== 1) return;
  mkdirSync(values.shots, { recursive: true });
  await page.screenshot({ path: join(values.shots, `${name}.png`) });
}

async function checkDiagnostics(page: Page, report: RunReport): Promise<void> {
  const opened = await call(page, "now");
  const first = await until("the type error squiggle", () => call(page, "errorSquiggles"), (texts) => texts.includes("count"));
  report.timings.openToSquiggleMs = (await call(page, "now")) - opened;
  const painted = await call(page, "errorSquiggleOffsets");
  const expectedOffset = (await call(page, "text")).indexOf("const count") + "const ".length;
  report.details.squigglesBeforeFix = { painted, expectedOffset };
  await shot(page, "squiggle", report.run);

  await call(page, "select", '"not a number"');
  const typed = await call(page, "now");
  await page.keyboard.type("42");
  await until("the typed fix", () => call(page, "text"), (text) => text.includes("const count: number = 42;"));
  const after = await until("the squiggle to clear", () => call(page, "errorSquiggles"), (texts) => !texts.includes("count"));
  report.timings.fixToClearMs = (await call(page, "now")) - typed;
  report.details.squigglesAfterFix = after;
  report.checks.diagnostics =
    first.length === 1 &&
    painted.length === 1 &&
    painted[0]!.text === "count" &&
    painted[0]!.offset === expectedOffset &&
    after.length === 0;
}

async function showHover(page: Page, needle: string, offset: number, expected: RegExp): Promise<string> {
  await call(page, "caretAt", needle, offset);
  return until(
    `a hover matching ${expected}`,
    async () => {
      const text = await call(page, "hoverText");
      if (!text) await call(page, "command", "editor.action.showHover");
      return text;
    },
    (text) => expected.test(text),
  );
}

async function checkHover(page: Page, report: RunReport): Promise<void> {
  const started = await call(page, "now");
  const text = await showHover(page, "const step", "const s".length, /step: Vector/);
  report.timings.hoverMs = (await call(page, "now")) - started;
  report.details.hover = text;
  await shot(page, "hover", report.run);
  await page.keyboard.press("Escape");
  report.checks.hover = /const step: Vector/.test(text);
}

async function completeAfter(page: Page, typed: string, expected: readonly string[]): Promise<readonly string[]> {
  await page.keyboard.type(typed);
  return until(
    `completions after ${typed}`,
    () => call(page, "completionLabels"),
    (labels) => expected.every((label) => labels.includes(label)),
  );
}

async function checkCompletion(page: Page, report: RunReport): Promise<void> {
  await call(page, "caretAtEnd");
  let started = await call(page, "now");
  const local = await completeAfter(page, "step.", ["add", "length", "x", "y"]);
  report.timings.localCompletionMs = (await call(page, "now")) - started;
  await shot(page, "completion", report.run);
  await erase(page, "step.");

  started = await call(page, "now");
  const fromPackage = await completeAfter(page, "ZERO.", ["amount", "currency"]);
  report.timings.packageCompletionMs = (await call(page, "now")) - started;
  await erase(page, "ZERO.");
  const text = await call(page, "text");
  report.details.completion = { local, fromPackage };
  report.checks.completion = text.endsWith("}\n");
}

/** Closes the completion list and deletes what was typed, key by key. */
async function erase(page: Page, typed: string): Promise<void> {
  await page.keyboard.press("Escape");
  for (const _ of typed) await page.keyboard.press("Backspace");
}

async function goToDefinition(page: Page, needle: string, offset: number, count: number) {
  await call(page, "caretAt", needle, offset);
  await call(page, "command", "editor.action.goToDefinition");
  const opened = await until("the definition to open", () => call(page, "opened"), (list) => list.length >= count);
  return opened[count - 1]!;
}

async function checkDefinition(page: Page, report: RunReport): Promise<void> {
  const mainPath = await call(page, "documentId");
  let started = await call(page, "now");
  const local = await goToDefinition(page, "new Vector", "new V".length, 1);
  report.timings.localDefinitionMs = (await call(page, "now")) - started;
  await call(page, "open", mainPath!);

  started = await call(page, "now");
  const fromPackage = await goToDefinition(page, "formatMoney(ZERO)", 2, 2);
  report.timings.packageDefinitionMs = (await call(page, "now")) - started;
  await call(page, "open", mainPath!);
  report.details.definition = { local, fromPackage };
  report.checks.definition =
    local.path === SHAPES_PATH &&
    local.documentId === SHAPES_PATH &&
    local.startLine === 5 &&
    local.selectedText.includes("Vector") &&
    fromPackage.path === MONEY_TYPES_PATH &&
    fromPackage.documentId === MONEY_TYPES_PATH &&
    fromPackage.startLine === 5 &&
    fromPackage.selectedText.includes("formatMoney");
}

async function checkCrashRestart(page: Page, report: RunReport): Promise<void> {
  await call(page, "caretAtEnd");
  await page.keyboard.type("const broken: string = 1;");
  await until("the squiggle on the unsaved line", () => call(page, "errorSquiggles"), (texts) => texts.includes("broken"));
  const before = await call(page, "launches");
  const trace: Record<string, unknown> = { textBeforeKill: await call(page, "text"), before };
  report.details.crashRestart = trace;

  await call(page, "watchSquiggles");
  const killedAt = await call(page, "now");
  trace.killedAtWallMs = Date.now() - report.startedWall;
  trace.killedPid = await call(page, "killServer");
  const launches = await until("a new server start", () => call(page, "launches"), (list) => list.length > before.length);
  const restart = launches.at(-1)!;
  trace.launches = launches;
  report.timings.killToRestartMs = restart.at - killedAt;

  const hover = await showHover(page, "const broken", "const b".length, /broken: string/);
  report.timings.killToHoverMs = (await call(page, "now")) - killedAt;
  const squiggles = await until("the squiggle after restart", () => call(page, "errorSquiggles"), (texts) => texts.includes("broken"));
  const timeline = await call(page, "squiggleTimeline");
  const cleared = timeline.findIndex((entry) => !entry.squiggles.includes("broken"));
  const back = timeline.findIndex((entry, index) => index > cleared && entry.squiggles.includes("broken"));
  const editorText = await call(page, "text");
  const diskText = await call(page, "readDisk", (await call(page, "documentId"))!);

  Object.assign(trace, { hover, squiggles, timeline });
  report.checks.crashRestart =
    launches.length === before.length + 1 &&
    restart.pid !== trace.killedPid &&
    restart.otherWorkers.length === 0 &&
    /const broken: string/.test(hover) &&
    cleared >= 0 &&
    back > cleared &&
    timeline[back]!.at > restart.at &&
    editorText.includes("const broken: string = 1;") &&
    !diskText.includes("broken");
}

async function checkDispose(page: Page, report: RunReport): Promise<void> {
  const launchesBefore = (await call(page, "launches")).length;
  const disposedAt = await call(page, "now");
  await call(page, "disposeEditor");
  await until("the server process and its worker to go", () => call(page, "workers"), (pids) => pids.length === 0);
  report.timings.disposeToGoneMs = (await call(page, "now")) - disposedAt;
  await Bun.sleep(2_000);
  const launchesAfter = (await call(page, "launches")).length;
  const workersAfter = await call(page, "workers");
  report.details.dispose = { launchesBefore, launchesAfter, workersAfter };
  report.checks.dispose = launchesAfter === launchesBefore && workersAfter.length === 0;
}

const STEPS: readonly [CheckName, (page: Page, report: RunReport) => Promise<void>][] = [
  ["diagnostics", checkDiagnostics],
  ["hover", checkHover],
  ["completion", checkCompletion],
  ["definition", checkDefinition],
  ["crashRestart", checkCrashRestart],
  ["dispose", checkDispose],
];

async function runOnce(origin: string, run: number): Promise<RunReport> {
  const report: RunReport = { run, startedWall: Date.now(), checks: {}, failures: {}, timings: {}, details: {}, console: [] };
  const context = await browser!.newContext({ viewport: { width: 960, height: 540 } });
  const stamp = () => `+${Date.now() - report.startedWall}ms`;
  try {
    const page = await context.newPage();
    page.on("console", (message) => void report.console.push(`${stamp()} ${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => void report.console.push(`${stamp()} pageerror: ${error.message}`));
    await page.goto(origin);
    await page.waitForFunction(() => window.__accept !== undefined, null, { timeout: HANG_CAP_MS });
    report.timings.bootMs = (await call(page, "start")).bootMs;
    for (const [name, step] of STEPS) {
      try {
        await step(page, report);
      } catch (error) {
        report.checks[name] = false;
        report.failures[name] = error instanceof Error ? error.message : String(error);
        report.details.atFailure = {
          text: await call(page, "text"),
          launches: await call(page, "launches"),
          workers: await call(page, "workers"),
          squiggles: await call(page, "errorSquiggles"),
          timeline: await call(page, "squiggleTimeline"),
        };
        break;
      }
    }
    await call(page, "disposeRuntime");
    report.checks.noErrorsLogged = !report.console.some((line) => / (error|pageerror): /.test(line));
  } finally {
    await context.close();
  }
  return report;
}

try {
  const built = await Bun.build({
    entrypoints: [
      join(here, "editor-page.ts"),
      Bun.resolveSync("@waffle-os/runtime/browser/fs-worker", here),
      Bun.resolveSync("@waffle-os/runtime/browser/preview1-worker", here),
    ],
    outdir: join(scratch, "www"),
    target: "browser",
    splitting: true,
    naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]", asset: "[name]-[hash].[ext]" },
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");

  const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
  const html = '<!doctype html><link rel="stylesheet" href="/editor.css"><script type="module" src="/editor-page.js"></script>';
  const editorCss = Bun.resolveSync("@singapore-editor/core/style.css", here);
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/") return new Response(html, { headers: { ...isolation, "Content-Type": "text/html" } });
      if (path === "/editor.css") return new Response(Bun.file(editorCss), { headers: { ...isolation, "Content-Type": "text/css" } });
      if (path.endsWith("/tsrs-lsp.wasm")) {
        return new Response(Bun.file(wasmPath), { headers: { ...isolation, "Content-Type": "application/wasm" } });
      }
      const file = Bun.file(join(scratch, "www", path));
      return file.exists().then((found) =>
        found ? new Response(file, { headers: isolation }) : new Response("not found", { status: 404, headers: isolation }),
      );
    },
  });

  browser = await chromium.launch({ headless: true });
  const reports: RunReport[] = [];
  for (let run = 1; run <= Number(values.runs); run++) {
    const report = await runOnce(`http://127.0.0.1:${server.port}/`, run);
    reports.push(report);
    const line = CHECKS.map((name) => `${name} ${report.checks[name] === undefined ? "not run" : report.checks[name] ? "pass" : "FAIL"}`);
    process.stdout.write(`run ${run}: ${line.join(", ")}\n`);
  }
  if (values.json) writeFileSync(values.json, JSON.stringify(reports, null, 2));
  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);

  const failed = reports.filter((report) => CHECKS.some((name) => report.checks[name] !== true));
  if (failed.length) throw new Error(`${failed.length} of ${reports.length} runs failed`);
  process.stdout.write(`all ${CHECKS.length} checks passed in ${reports.length} runs\n`);
} finally {
  await browser?.close();
  await server?.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}
