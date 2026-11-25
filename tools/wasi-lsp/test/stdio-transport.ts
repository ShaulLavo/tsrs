// A Singapore `LspManagedTransport` over a Waffle command's stdin and stdout, for this test only. Sprockt uses
// Singapore's own `createStdioLspTransport` (DESIGN.md); this keeps the test on released Singapore packages.
import type { LspManagedTransport, LspTransportHandler } from "@singapore-editor/lsp";
import type { Runtime } from "@waffle-os/runtime";
import { startCommand, type CommandResult } from "@waffle-os/runtime/command";

export type StdioServer = {
  readonly transport: LspManagedTransport;
  readonly result: Promise<CommandResult>;
  stderr(): string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function startStdioServer(runtime: Runtime, executable: string, cwd: string): StdioServer {
  const handlers = new Set<LspTransportHandler>();
  const closeHandlers = new Set<(error?: unknown) => void>();
  let stdinController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let stderrText = "";
  let pending: Uint8Array = new Uint8Array(0);

  const stdin = new ReadableStream<Uint8Array>({
    start: (controller) => {
      stdinController = controller;
    },
  });
  const receive = (chunk: Uint8Array): undefined => {
    pending = concat(pending, chunk);
    for (let message = takeFrame(); message !== null; message = takeFrame()) {
      for (const handler of handlers) handler(message);
    }
  };
  const takeFrame = (): string | null => {
    const headerEnd = indexOfHeaderEnd(pending);
    if (headerEnd < 0) return null;
    const header = decoder.decode(pending.subarray(0, headerEnd));
    const length = Number(/content-length: *(\d+)/i.exec(header)?.[1]);
    if (!Number.isSafeInteger(length)) throw new Error(`bad LSP header: ${header}`);
    const start = headerEnd + 4;
    if (pending.length < start + length) return null;
    const body = decoder.decode(pending.subarray(start, start + length));
    pending = pending.slice(start + length);
    return body;
  };

  const command = startCommand(runtime, executable, {
    filesystem: "runtime-root",
    cwd,
    env: { PWD: cwd },
    stdin,
    stdout: { limitBytes: 0, onChunk: receive },
    stderr: {
      limitBytes: 0,
      onChunk: (bytes) => {
        stderrText = (stderrText + decoder.decode(bytes, { stream: true })).slice(-4096);
      },
    },
  });
  const finish = (error?: unknown) => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) handler(error);
  };
  command.result.then(
    (result) => finish(new Error(`language server exited: ${JSON.stringify(result.exit)}`)),
    (error: unknown) => finish(error),
  );

  const transport: LspManagedTransport = {
    isClosed: () => closed,
    send(message) {
      if (closed) throw new Error("language server is not running");
      const body = encoder.encode(message);
      stdinController!.enqueue(concat(encoder.encode(`Content-Length: ${body.length}\r\n\r\n`), body));
    },
    subscribe: (handler) => void handlers.add(handler),
    unsubscribe: (handler) => void handlers.delete(handler),
    onDidClose(handler) {
      closeHandlers.add(handler);
      return () => void closeHandlers.delete(handler);
    },
    close() {
      if (closed) return;
      stdinController!.close();
      void command.kill();
    },
  };
  return { transport, result: command.result, stderr: () => stderrText };
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left);
  merged.set(right, left.length);
  return merged;
}

function indexOfHeaderEnd(bytes: Uint8Array): number {
  for (let index = 0; index + 3 < bytes.length; index++) {
    if (bytes[index] === 13 && bytes[index + 1] === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10) return index;
  }
  return -1;
}
