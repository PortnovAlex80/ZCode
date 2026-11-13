import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const { terminateProcessTreeAndWaitMock } = vi.hoisted(() => ({
  terminateProcessTreeAndWaitMock: vi.fn(async () => ({ remainingPids: [] as number[] })),
}));

vi.mock("#src/process/processTreeTerminator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/process/processTreeTerminator.js")>()),
  captureProcessTreeSnapshotAsync: vi.fn(async (child: { pid?: number }) => ({
    rootPid: child.pid!,
    descendantPids: [],
    identities: [],
  })),
  terminateProcessTreeAndWait: terminateProcessTreeAndWaitMock,
}));

import { ZCodeStdioTransport } from "../src/zcode-agent/zcodeStdioTransport.js";
import type { WindowsRuntimeHost } from "../src/windows-runtime-host/contract.js";
// Mocked module export (see vi.mock above) — the owner fake calls this so the
// shared mock records the reclamation contract.
import { terminateProcessTreeAndWait } from "#src/process/processTreeTerminator.js";

const activeChildren = new Set<ReturnType<typeof spawn>>();

afterEach(async () => {
  terminateProcessTreeAndWaitMock.mockClear();
  vi.restoreAllMocks();
  await Promise.all(
    [...activeChildren].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
          child.kill("SIGKILL");
        }),
    ),
  );
  activeChildren.clear();
});

describe("ZCodeStdioTransport process tree result", () => {
  it("等待器确认 OS 进程树已退出时不被滞后的 ChildProcess 状态改判为残留", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    activeChildren.add(child);
    // Upstream v3.18 moved Windows cleanup behind the runtime Job owner
    // (ownerless win32 dispose now throws). Mirror the production owner shape:
    // close() treats the mocked OS terminator result as ground truth and
    // resolves without waiting for Node's lagging exit/close events.
    const owner: WindowsRuntimeHost = {
      child,
      runtimePid: child.pid ?? 0,
      ready: () => Promise.resolve(child.pid ?? 0),
      start: async () => undefined,
      onRootExit: () => {},
      async close() {
        await terminateProcessTreeAndWait(child, {
          ownedProcessStartedAtMs: 10_000,
          ownedProcessExitedAtMs: 10_000,
          forceAfterMs: 2_000,
        });
      },
    };
    const transport = new ZCodeStdioTransport(child, { windowsRuntime: owner });
    const startedAt = performance.now();

    // Bug regression (moved to the owner boundary): the OS waiter has confirmed
    // the tree is gone while Node's exit event can still lag a tick, leaving
    // child.exitCode legitimately null. dispose resolves on the OS fact.
    await expect(transport.disposeAndWait()).resolves.toBeUndefined();
    // stderr drain only borrows 250ms; it must not re-borrow the whole
    // Windows process-tree window.
    expect(performance.now() - startedAt).toBeLessThan(3_500);
    expect(terminateProcessTreeAndWaitMock).toHaveBeenCalledOnce();
    expect(terminateProcessTreeAndWaitMock).toHaveBeenCalledWith(
      child,
      expect.objectContaining({ forceAfterMs: 2_000 }),
    );
    expect(child.exitCode).toBeNull();
  });
});
