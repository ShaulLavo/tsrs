// Browser entry for the editor acceptance run: a Singapore editor with the language server plugin from
// sprockt-glue.ts, wired the way an app wires it, on one Waffle runtime with the default persistent filesystem.
// editor-acceptance.ts drives it through `window.__accept` and real keyboard input, and reads only what the page
// shows: highlights, the hover, the completion list, the open document and its selection.
import { Editor } from "@singapore-editor/core";
import { createRuntime, type Runtime } from "@waffle-os/runtime";
import { TSRS_LSP_PATH, tsrsLsp } from "../src/program.ts";
import { FIXTURE_FILES, MAIN_PATH, PROJECT_ROOT } from "./fixture.ts";
import { createGuestLanguageServerPlugin, type LanguageServerHost } from "./sprockt-glue.ts";

/** One guest start the launcher saw, with every other worker still alive at that moment. */
export type Launch = { readonly pid: number; readonly at: number; readonly otherWorkers: readonly number[] };
/** One `openFile` from the plugin's definition navigation, after the editor applied it. */
export type Opened = {
  readonly path: string;
  readonly startLine: number;
  readonly selectedText: string;
  readonly documentId: string | null;
  readonly at: number;
};
type LspRange = Parameters<LanguageServerHost["openFile"]>[1];

export type AcceptancePage = {
  start(): Promise<{ readonly bootMs: number }>;
  now(): number;
  documentId(): string | null;
  text(): string;
  readDisk(path: string): Promise<string>;
  errorSquiggles(): readonly string[];
  errorSquiggleOffsets(): readonly { readonly text: string; readonly offset: number | null }[];
  hoverText(): string;
  completionLabels(): readonly string[];
  caretAt(needle: string, offsetInNeedle: number): void;
  select(needle: string): void;
  caretAtEnd(): void;
  command(id: string): boolean;
  open(path: string): Promise<void>;
  opened(): readonly Opened[];
  launches(): readonly Launch[];
  workers(): Promise<readonly number[]>;
  killServer(): Promise<number>;
  watchSquiggles(): void;
  squiggleTimeline(): readonly { readonly at: number; readonly squiggles: readonly string[] }[];
  disposeEditor(): void;
  disposeRuntime(): Promise<void>;
};

declare global {
  interface Window {
    __accept?: AcceptancePage;
  }
}

const decoder = new TextDecoder();
const launches: Launch[] = [];
const opened: Opened[] = [];
// The tab model of a small app: each path keeps its unsaved text while another file is shown.
const tabs = new Map<string, string>();
const timeline: { at: number; squiggles: readonly string[] }[] = [];
let watching = false;

const runtime: Runtime = createRuntime({
  filesystem: { workerURL: "/fs-worker.js", name: `editor-acceptance-${Date.now()}` },
  programs: {
    launcher: (context, service) => {
      const otherWorkers = service
        .workerMemory()
        .map((worker) => worker.pid)
        .filter((pid) => pid !== context.pid);
      launches.push({ pid: context.pid, at: performance.now(), otherWorkers });
      return service.launchWorker(context, {
        workerUrl: "/preview1-worker.js",
        request: {
          module: context.module,
          args: context.request.argv,
          env: context.request.env,
          interruptible: context.interruptible,
        },
      });
    },
  },
});

const host = document.createElement("div");
host.style.cssText = "position:absolute;inset:0;";
document.body.style.cssText = "margin:0;height:100vh;";
document.body.append(host);

// Created in start(), after the program is installed: the plugin starts the server as the editor mounts.
let editor: Editor;

function createEditor(): Editor {
  const plugin = createGuestLanguageServerPlugin(
    runtime,
    "typescript",
    { executable: TSRS_LSP_PATH, args: [], rootPath: PROJECT_ROOT, env: { PWD: PROJECT_ROOT } },
    { openFile: (path, range) => void openAt(path, range) },
  );
  return new Editor(host, { plugins: [plugin] });
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

function offsetOf(text: string, position: LspRange["start"]): number {
  const start = lineStarts(text)[position.line] ?? text.length;
  return Math.min(start + position.character, text.length);
}

function offsetOfNeedle(needle: string): number {
  const index = editor.materializeFullText().indexOf(needle);
  if (index < 0) throw new Error(`the open document lacks ${JSON.stringify(needle)}`);
  return index;
}

async function open(path: string): Promise<void> {
  const current = editor.getState().documentId;
  if (current) tabs.set(current, editor.materializeFullText());
  let text = tabs.get(path);
  if (text === undefined) {
    const bytes = await runtime.filesystem.readFile(path);
    if (!bytes) throw new Error(`no file at ${path}`);
    text = decoder.decode(bytes);
  }
  tabs.set(path, text);
  editor.openDocument({ documentId: path, text, languageId: "typescript" });
}

async function openAt(path: string, range: LspRange): Promise<void> {
  await open(path);
  const text = editor.materializeFullText();
  const from = offsetOf(text, range.start);
  const to = offsetOf(text, range.end);
  editor.setSelection(from, to, { revealOffset: from });
  opened.push({
    path,
    startLine: range.start.line,
    selectedText: text.slice(from, to),
    documentId: editor.getState().documentId ?? null,
    at: performance.now(),
  });
}

function errorSquiggles(): readonly string[] {
  const texts: string[] = [];
  for (const [name, highlight] of CSS.highlights) {
    if (!name.includes("lsp-plugin-error")) continue;
    for (const range of highlight) texts.push(range.toString());
  }
  return texts;
}

/** Each painted error range with the editor offset under its first character. */
function errorSquiggleOffsets(): readonly { readonly text: string; readonly offset: number | null }[] {
  const found: { text: string; offset: number | null }[] = [];
  for (const [name, highlight] of CSS.highlights) {
    if (!name.includes("lsp-plugin-error")) continue;
    for (const range of highlight) {
      const box = (range as Range).getBoundingClientRect();
      found.push({ text: range.toString(), offset: editor.textOffsetFromPoint(box.left + 1, box.top + box.height / 2) });
    }
  }
  return found;
}

function visibleText(selector: string): string {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element || element.getClientRects().length === 0) return "";
  return element.innerText;
}

function sampleSquiggles(): void {
  if (!watching) return;
  const squiggles = errorSquiggles();
  if (JSON.stringify(timeline.at(-1)?.squiggles) !== JSON.stringify(squiggles)) {
    timeline.push({ at: performance.now(), squiggles });
  }
  requestAnimationFrame(sampleSquiggles);
}

async function liveWorkers(): Promise<readonly number[]> {
  return (await runtime.processes()).workerMemory().map((worker) => worker.pid);
}

window.__accept = {
  async start() {
    const started = performance.now();
    for (const [path, text] of Object.entries(FIXTURE_FILES)) {
      const full = `${PROJECT_ROOT}/${path}`;
      await runtime.filesystem.mkdirp(full.slice(0, full.lastIndexOf("/")));
      await runtime.filesystem.writeFile(full, text);
    }
    await runtime.programs.onDemand(tsrsLsp);
    editor = createEditor();
    await open(MAIN_PATH);
    return { bootMs: performance.now() - started };
  },
  now: () => performance.now(),
  documentId: () => editor.getState().documentId ?? null,
  text: () => editor.materializeFullText(),
  readDisk: async (path) => decoder.decode((await runtime.filesystem.readFile(path)) ?? new Uint8Array()),
  errorSquiggles,
  errorSquiggleOffsets,
  hoverText: () => visibleText('[class*="-hover-body"]'),
  completionLabels: () =>
    Array.from(
      document.querySelectorAll<HTMLElement>('.editor-lsp-plugin-completion [role="option"]'),
      (row) => (row.children[1] ?? row).textContent ?? "",
    ),
  caretAt(needle, offsetInNeedle) {
    const offset = offsetOfNeedle(needle) + offsetInNeedle;
    editor.setSelection(offset, offset, { revealOffset: offset });
    editor.focus();
  },
  select(needle) {
    const from = offsetOfNeedle(needle);
    editor.setSelection(from, from + needle.length, { revealOffset: from });
    editor.focus();
  },
  caretAtEnd() {
    const end = editor.getTextSnapshot().length;
    editor.setSelection(end, end, { revealOffset: end });
    editor.focus();
  },
  command: (id) => editor.dispatchCommand(id as Parameters<Editor["dispatchCommand"]>[0]),
  open,
  opened: () => opened,
  launches: () => launches,
  workers: liveWorkers,
  async killServer() {
    const pid = launches.at(-1)?.pid;
    if (pid === undefined) throw new Error("no server was started");
    await (await runtime.processes()).kill(pid, 9);
    return pid;
  },
  watchSquiggles() {
    watching = true;
    timeline.length = 0;
    sampleSquiggles();
  },
  squiggleTimeline: () => timeline,
  disposeEditor() {
    watching = false;
    editor.dispose();
  },
  disposeRuntime: () => runtime.dispose(),
};
