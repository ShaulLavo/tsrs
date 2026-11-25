// One editor session through Singapore's LSP client: document sync, pull diagnostics (the plugin's own
// controller), hover, completion and definition, then warm timings.
import { LspClient, arrayLspLineStarts, type LspDocument, type LspManagedTransport, type lsp } from "@singapore-editor/lsp";
// Not in the package's exports map; the plugin builds one per document lane (src/document.ts).
import { PullDiagnosticsController } from "../node_modules/@singapore-editor/lsp-plugin/dist/pullDiagnostics.js";
import { MAIN_PATH, MAIN_TEXT, PROJECT_ROOT } from "./fixture.ts";

export type ScenarioResult = {
  readonly checks: Record<string, boolean>;
  readonly details: Record<string, unknown>;
  readonly timings: {
    readonly initializeMs: number;
    readonly firstDiagnosticsMs: number;
    readonly warm: Record<"diagnosticsAfterEditMs" | "hoverMs" | "completionMs" | "definitionMs", number[]>;
  };
};

const HANG_CAP_MS = 120_000;
const fileUri = (path: string) => `file://${path}`;

function makeDocument(uri: string, version: number, text: string): LspDocument {
  const starts = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  return {
    uri,
    languageId: "typescript",
    version,
    textSnapshot: {
      length: text.length,
      readRange: (start, end) => text.slice(start, end),
      forEachTextChunk: (visit) => visit(text, 0, text.length),
    },
    lineStarts: arrayLspLineStarts(starts),
    sourceRevision: version,
    sourceSegment: {},
  };
}

function positionOf(text: string, needle: string, offsetInNeedle: number): lsp.Position {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`fixture lacks ${needle}`);
  const lines = text.slice(0, index + offsetInNeedle).split("\n");
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

const hoverText = (hover: lsp.Hover | null): string => {
  const contents = hover?.contents;
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map((item) => (typeof item === "string" ? item : item.value)).join("\n");
  return contents?.value ?? "";
};

const completionLabels = (result: lsp.CompletionList | lsp.CompletionItem[] | null): string[] =>
  (Array.isArray(result) ? result : (result?.items ?? [])).map((item) => item.label);

const definitionTargets = (result: lsp.Definition | lsp.LocationLink[] | null) =>
  (Array.isArray(result) ? result : result ? [result] : []).map((item) =>
    "targetUri" in item
      ? { uri: item.targetUri, line: item.targetSelectionRange.start.line }
      : { uri: item.uri, line: item.range.start.line },
  );

const hasTypeError = (items: readonly lsp.Diagnostic[]) => items.some((item) => String(item.code) === "2322");

export async function runScenario(
  transport: LspManagedTransport,
  now: () => number,
  started: number,
  whileRunning: () => Promise<unknown>,
  warmRounds = 5,
): Promise<ScenarioResult> {
  const rootUri = fileUri(PROJECT_ROOT);
  const mainUri = fileUri(MAIN_PATH);
  const checks: Record<string, boolean> = {};
  const details: Record<string, unknown> = {};

  const client = new LspClient({ rootUri, workspaceFolders: [{ uri: rootUri, name: "project" }], timeoutMs: HANG_CAP_MS });
  await client.connect(transport);
  const initializeMs = now() - started;
  details.serverInfo = client.initializeResult?.serverInfo ?? null;

  let document = makeDocument(mainUri, 1, MAIN_TEXT);
  let waiter: { version: number; resolve: (items: readonly lsp.Diagnostic[]) => void } | null = null;
  const diagnostics = new PullDiagnosticsController({
    client,
    getDocument: () => ({ uri: document.uri, version: document.version }),
    publish: (published, items) => {
      if (waiter?.version === published.version) waiter.resolve(items);
    },
    onRequestError: (error) => {
      throw error;
    },
  });
  const nextDiagnostics = (what: string) =>
    new Promise<readonly lsp.Diagnostic[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), HANG_CAP_MS);
      waiter = {
        version: document.version,
        resolve: (items) => {
          clearTimeout(timer);
          waiter = null;
          resolve(items);
        },
      };
      diagnostics.synchronize();
    });
  const replace = (needle: string, replacement: string) => {
    const previous = document;
    const text = previous.textSnapshot.readRange(0, previous.textSnapshot.length);
    const from = text.indexOf(needle);
    if (from < 0) throw new Error(`document lacks ${needle}`);
    document = makeDocument(mainUri, previous.version + 1, text.slice(0, from) + replacement + text.slice(from + needle.length));
    client.didChangeDocument(document, {
      edits: [{ from, to: from + needle.length, text: replacement }],
      previousSnapshot: { textSnapshot: previous.textSnapshot, lineStarts: previous.lineStarts },
    });
  };

  client.didOpenDocument(document);
  const first = await nextDiagnostics("first diagnostics");
  const firstDiagnosticsMs = now() - started;
  const typeError = first.find((item) => String(item.code) === "2322");
  checks.diagnosticAppears = typeError?.range.start.line === positionOf(MAIN_TEXT, "const count", 0).line;
  details.firstDiagnostic = typeError?.message ?? null;

  const textDocument = { uri: mainUri };
  const hoverAt = positionOf(MAIN_TEXT, "const step", "const ".length + 1);
  const memberAt = positionOf(MAIN_TEXT, "step.length", "step.".length);
  const packageMemberAt = positionOf(MAIN_TEXT, "ZERO.amount", "ZERO.".length);
  const localDefinitionAt = positionOf(MAIN_TEXT, "new Vector", "new ".length + 1);
  const packageDefinitionAt = positionOf(MAIN_TEXT, "formatMoney(ZERO)", 2);
  const memberContext = { triggerKind: 2, triggerCharacter: "." };
  const hover = () => client.request<lsp.Hover | null>("textDocument/hover", { textDocument, position: hoverAt });
  const complete = (position: lsp.Position) =>
    client.request<lsp.CompletionList | lsp.CompletionItem[] | null>("textDocument/completion", { textDocument, position, context: memberContext });
  const define = (position: lsp.Position) =>
    client.request<lsp.Definition | lsp.LocationLink[] | null>("textDocument/definition", { textDocument, position });

  details.hover = hoverText(await hover());
  checks.hover = /step: Vector/.test(details.hover as string);

  const members = completionLabels(await complete(memberAt));
  checks.localMemberCompletion = ["add", "length", "x", "y"].every((label) => members.includes(label));
  details.localMembers = members.slice(0, 20);

  const packageMembers = completionLabels(await complete(packageMemberAt));
  checks.packageMemberCompletion = ["amount", "currency"].every((label) => packageMembers.includes(label));
  details.packageMembers = packageMembers.slice(0, 20);

  const localDefinition = definitionTargets(await define(localDefinitionAt));
  checks.localDefinition = localDefinition.some((target) => target.uri === fileUri(`${PROJECT_ROOT}/src/shapes.ts`) && target.line === 5);
  details.localDefinition = localDefinition;

  const packageDefinition = definitionTargets(await define(packageDefinitionAt));
  checks.packageDefinition = packageDefinition.some(
    (target) => target.uri === fileUri(`${PROJECT_ROOT}/node_modules/tiny-money/index.d.ts`) && target.line === 5,
  );
  details.packageDefinition = packageDefinition;

  replace('"not a number"', "42");
  checks.diagnosticClears = !hasTypeError(await nextDiagnostics("diagnostics after the fix"));

  const warm = { diagnosticsAfterEditMs: [] as number[], hoverMs: [] as number[], completionMs: [] as number[], definitionMs: [] as number[] };
  let warmDiagnosticsCorrect = true;
  for (let round = 0; round < warmRounds; round++) {
    const breaking = round % 2 === 0;
    const editStarted = now();
    if (breaking) replace("42", '"not a number"');
    else replace('"not a number"', "42");
    warmDiagnosticsCorrect &&= hasTypeError(await nextDiagnostics("warm diagnostics")) === breaking;
    warm.diagnosticsAfterEditMs.push(now() - editStarted);

    const hoverStarted = now();
    await hover();
    warm.hoverMs.push(now() - hoverStarted);

    const completionStarted = now();
    await complete(memberAt);
    warm.completionMs.push(now() - completionStarted);

    const definitionStarted = now();
    await define(packageDefinitionAt);
    warm.definitionMs.push(now() - definitionStarted);
  }
  checks.warmDiagnosticsFollowEdits = warmDiagnosticsCorrect;
  details.whileRunning = await whileRunning();

  diagnostics.dispose();
  await client.shutdown();
  return { checks, details, timings: { initializeMs, firstDiagnosticsMs, warm } };
}
