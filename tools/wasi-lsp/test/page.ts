// Browser entry: one Waffle runtime on the default persistent filesystem, the fixture project written into it,
// tsrs-lsp installed as a program, and the scenario run through Singapore's client. The result is on
// `window.__result` (or `window.__error`).
import { createRuntime } from "@waffle-os/runtime";
import { TSRS_LSP_PATH, tsrsLsp } from "../src/program.ts";
import { FIXTURE_FILES, PROJECT_ROOT } from "./fixture.ts";
import { runScenario } from "./scenario.ts";
import { startStdioServer } from "./stdio-transport.ts";

declare global {
  interface Window {
    __result?: unknown;
    __error?: string;
  }
}

async function main(): Promise<void> {
  const runtime = createRuntime({
    filesystem: { workerURL: "/fs-worker.js", name: `tsrs-lsp-${Date.now()}` },
    programs: {
      launcher: (context, service) =>
        service.launchWorker(context, {
          workerUrl: "/preview1-worker.js",
          request: {
            module: context.module,
            args: context.request.argv,
            env: context.request.env,
            interruptible: context.interruptible,
          },
        }),
    },
  });
  try {
    for (const [path, text] of Object.entries(FIXTURE_FILES)) {
      const full = `${PROJECT_ROOT}/${path}`;
      await runtime.filesystem.mkdirp(full.slice(0, full.lastIndexOf("/")));
      await runtime.filesystem.writeFile(full, text);
    }
    await runtime.programs.onDemand(tsrsLsp);

    const started = performance.now();
    const server = startStdioServer(runtime, TSRS_LSP_PATH, PROJECT_ROOT);
    // Linear memory never shrinks, so the sample after the warm rounds is the session's peak.
    const sampleMemory = async () => ({
      guestLinearMemoryBytes: Math.max(0, ...(await runtime.processes()).workerMemory().map((sample) => sample.bytes ?? 0)),
      guestDeclaredMaximumBytes: runtime.sharedMemory
        .snapshot()
        .holders.filter((holder) => holder.label === "guest-memory")
        .map((holder) => holder.declaredBytes),
    });
    const scenario = await runScenario(server.transport, () => performance.now(), started, sampleMemory);
    const exit = await server.result;
    window.__result = { ...scenario, exit: exit.exit, stderr: server.stderr() };
  } finally {
    await runtime.dispose();
  }
}

main().catch((error: unknown) => {
  window.__error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
});
