import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { openUrlInBrowser } from "../src/auth/browser.js";

describe("OAuth system browser launcher", () => {
  it("passes the complete Windows authorization URL as a literal without cmd parsing", async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const launch = vi.fn(() => {
      queueMicrotask(() => child.emit("exit", 0));
      return child as unknown as ChildProcess;
    });
    const url =
      "https://auth.openai.com/authorize?client_id=dynamic_agent_client&state=a&nonce=b&login_hint=o'brien";
    await expect(
      openUrlInBrowser(url, { platform: "win32", spawnProcess: launch as unknown as typeof spawn }),
    ).resolves.toMatchObject({ opened: true });
    const [command, args] = (launch.mock.calls as unknown as [string, string[]][])[0]!;
    expect(command).toBe("powershell.exe");
    expect(Buffer.from(args.at(-1)!, "base64").toString("utf16le")).toBe(
      `Start-Process -FilePath '${url.replaceAll("'", "''")}' -ErrorAction Stop`,
    );
  });

  it("reports launcher exit failure even after the process spawned", async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const launch = () => {
      queueMicrotask(() => {
        child.emit("spawn");
        child.emit("exit", 1);
      });
      return child as unknown as ChildProcess;
    };
    await expect(
      openUrlInBrowser("https://example.com", { spawnProcess: launch as typeof spawn }),
    ).resolves.toMatchObject({ opened: false });
  });
});
