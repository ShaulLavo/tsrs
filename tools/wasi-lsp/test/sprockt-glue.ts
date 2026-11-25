// The page-side wiring between a Singapore editor and a language server process on Waffle.
// Copy into Sprockt. It is also the piece the headless Chromium acceptance run should reuse.
// Needs: Waffle with `programs: "guest"` and `onLeaderExit` (waffle#629), and Singapore with
// `createStdioLspTransport` (singapore#185).

import { startCommand } from "@waffle-os/runtime/command";
import type { Runtime } from "@waffle-os/runtime";
import {
  LspServerExitedError,
  createStdioLspTransport,
  type LspManagedTransport,
} from "@singapore-editor/lsp";
import {
  LspConnectionPool,
  createLanguageServerAdapterPlugin,
  fileUriToPath,
  pathToFileUri,
  type LanguageServerDefinitionTarget,
  type LanguageServerPlugin,
} from "@singapore-editor/lsp-plugin";

export type GuestServer = {
  /** The registered Bun path of the chosen engine, `/bin/bun` for the browser engine. */
  readonly executable: string;
  readonly args: readonly string[];
  /** The workspace directory in the Waffle filesystem. Also the server's root URI. */
  readonly rootPath: string;
  readonly env: Readonly<Record<string, string>>;
};

const STDERR_TAIL_BYTES = 4096;

/** Keeps the end of the server's stderr, for the message shown when it exits. */
function createStderrTail() {
  const decoder = new TextDecoder();
  let text = "";
  return {
    push(bytes: Uint8Array): undefined {
      text = (text + decoder.decode(bytes, { stream: true })).slice(-STDERR_TAIL_BYTES);
    },
    text: () => text,
  };
}

/** Starts the server process and returns the transport of this one run. */
export function connectLanguageServer(runtime: Runtime, server: GuestServer): LspManagedTransport {
  const stderr = createStderrTail();
  const stdio = createStdioLspTransport({ stop: () => void command.kill() });
  const command = startCommand(runtime, server.executable, {
    filesystem: "runtime-root",
    programs: "guest",
    onLeaderExit: "stop",
    args: server.args,
    cwd: server.rootPath,
    env: server.env,
    stdin: stdio.stdin,
    stdout: { limitBytes: 0, onChunk: (bytes) => void stdio.stdout(bytes) },
    stderr: { limitBytes: 0, onChunk: stderr.push },
  });
  void command.result.then(
    ({ exit }) =>
      stdio.exited(
        new LspServerExitedError({
          outcome: exit?.kind ?? "killed",
          exitCode: exit?.kind === "exited" ? exit.code : null,
          exitSignal: exit?.kind === "signaled" ? String(exit.code) : null,
          stderrTail: stderr.text(),
        }),
      ),
    (error: unknown) => stdio.exited(error),
  );
  return stdio.transport;
}

export type LanguageServerHost = {
  /** Open the file at this absolute Waffle path and select the range. */
  openFile(path: string, range: LanguageServerDefinitionTarget["range"]): void;
};

/** One pool for the page, so a file switch reuses the running server. */
const pool = new LspConnectionPool();

export function createGuestLanguageServerPlugin(
  runtime: Runtime,
  name: string,
  server: GuestServer,
  host: LanguageServerHost,
): LanguageServerPlugin {
  return createLanguageServerAdapterPlugin({
    name,
    rootUri: pathToFileUri(server.rootPath),
    createTransport: () => connectLanguageServer(runtime, server),
    reconnect: { delaysMs: [250, 1000, 4000] },
    connectionProvider: pool.provider(`${name}:${server.rootPath}`),
    // Document ids are absolute Waffle paths, mapped to URIs exactly.
    documentSync: {
      uriForDocument: (snapshot) =>
        snapshot.documentId ? pathToFileUri(snapshot.documentId) : null,
    },
    onOpenDefinition(target) {
      const path = fileUriToPath(target.uri);
      if (path === null) return false;
      host.openFile(path, target.range);
      return true;
    },
  });
}
