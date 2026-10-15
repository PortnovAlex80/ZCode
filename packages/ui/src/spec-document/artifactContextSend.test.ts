import { describe, expect, it, vi } from "vitest";
import type { IProjectMetadataService } from "@zcode/services";
import { prepareArtifactText } from "./artifactContextSend.js";

describe("explicit artifact context at native send boundary", () => {
  it("disabled context never resolves metadata or changes the user's text", async () => {
    const resolve = vi.fn();
    const text = " /plan оформить титул\n";
    expect(
      await prepareArtifactText({
        service: { resolve } as unknown as IProjectMetadataService,
        workspacePath: "D:/odn",
        path: "docs/title.md",
        enabled: false,
        text,
      }),
    ).toBe(text);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("reads fresh per-project metadata each send and freezes previous output", async () => {
    let revision = "first-passport";
    const resolve = vi.fn(async () => ({ text: revision }));
    const service = { resolve } as unknown as IProjectMetadataService;
    const input = {
      service,
      workspacePath: "D:/odn",
      path: "docs/title.md",
      enabled: true,
      text: "Update",
    };
    const first = await prepareArtifactText(input);
    revision = "updated-passport";
    expect(await prepareArtifactText(input)).toBe("Update\n\nupdated-passport");
    expect(first).toBe("Update\n\nfirst-passport");
    expect(resolve).toHaveBeenNthCalledWith(1, { workspacePath: "D:/odn", path: "docs/title.md" });
    expect(resolve).toHaveBeenNthCalledWith(2, { workspacePath: "D:/odn", path: "docs/title.md" });
  });

  it("refuses an enabled send on missing or corrupt metadata instead of silently omitting it", async () => {
    const input = {
      workspacePath: "D:/odn",
      path: "docs/title.md",
      enabled: true,
      text: "Preserved draft",
    };
    await expect(prepareArtifactText(input)).rejects.toThrow("unavailable");
    const service = {
      resolve: vi.fn().mockRejectedValue(new Error("Corrupt passport")),
    } as unknown as IProjectMetadataService;
    await expect(prepareArtifactText({ ...input, service })).rejects.toThrow("Corrupt passport");
    expect(input.text).toBe("Preserved draft");
  });
});
