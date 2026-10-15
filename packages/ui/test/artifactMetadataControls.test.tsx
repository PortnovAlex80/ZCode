// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IProjectMetadataService,
  ProjectMetadataEntries,
  ProjectMetadataEntry,
} from "@zcode/services";
import { ArtifactMetadataControls } from "@/spec-document/ArtifactMetadataControls.js";

const host = vi.hoisted(() => ({ service: undefined as IProjectMetadataService | undefined }));
vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => ({ projectMetadataService: host.service }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
beforeAll(() => {
  if (!window.PointerEvent) window.PointerEvent = MouseEvent as typeof PointerEvent;
  HTMLElement.prototype.hasPointerCapture ??= () => false;
  HTMLElement.prototype.setPointerCapture ??= () => {};
  HTMLElement.prototype.releasePointerCapture ??= () => {};
  HTMLElement.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => {
  host.service = service();
});
afterEach(cleanup);

const path = "documents/title.md";
const workspacePath = "D:/ODN-pilot";
function passport(purpose = "Title page"): ProjectMetadataEntry {
  return {
    id: "stable-title-id",
    updatedAt: "2026-10-15T00:00:00.000Z",
    kind: "document",
    type: "note",
    purpose,
    sources: ["requisites.txt"],
    links: [],
    methods: [],
  };
}
function service() {
  return {
    read: vi.fn(async (): Promise<ProjectMetadataEntries> => ({ [path]: passport() })),
    save: vi.fn(async (): Promise<ProjectMetadataEntries> => ({ [path]: passport() })),
    remove: vi.fn(async (): Promise<ProjectMetadataEntries> => ({})),
    resolve: vi.fn(async () => ({
      path,
      revision: "rev-1",
      entries: [{ path: ".", entry: { ...passport(), kind: "folder" as const } }],
      text: "Project instructions",
    })),
  };
}
function edit() {
  fireEvent.click(screen.getByRole("button", { name: "artifactMetadata.edit" }));
}
function openMenu() {
  fireEvent.pointerDown(screen.getByTestId("artifact-context-trigger"), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}
async function loadedEditor() {
  await waitFor(() =>
    expect(
      (screen.getByLabelText("artifactMetadata.field.purpose") as HTMLTextAreaElement).value,
    ).toBe("Title page"),
  );
}

describe("artifact metadata controls", () => {
  it("reads only on opening and saves an edited passport through the workspace service", async () => {
    render(<ArtifactMetadataControls workspacePath={workspacePath} path={path} />);
    expect(host.service!.read).not.toHaveBeenCalled();
    expect(host.service!.resolve).not.toHaveBeenCalled();
    edit();
    await loadedEditor();
    fireEvent.change(screen.getByLabelText("artifactMetadata.field.purpose"), {
      target: { value: "ODN title" },
    });
    fireEvent.change(screen.getByLabelText("artifactMetadata.field.instructions"), {
      target: { value: "Preserve author edits" },
    });
    fireEvent.change(screen.getByLabelText("artifactMetadata.field.skills"), {
      target: { value: "skills/title.md\n\nskills/checks.md" },
    });
    fireEvent.change(screen.getByLabelText("artifactMetadata.field.checklist"), {
      target: { value: "Check designation\nCheck year" },
    });
    fireEvent.change(screen.getByLabelText("artifactMetadata.field.steps"), {
      target: {
        value: JSON.stringify([
          {
            title: "Read",
            instruction: "Read requisites",
            tool: { transport: "mcp", connection: "odn", operation: "read_project" },
            input: "project-id",
          },
        ]),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(host.service!.save).toHaveBeenCalledWith({
      workspacePath,
      path,
      entry: {
        kind: "document",
        purpose: "ODN title",
        type: "note",
        instructions: "Preserve author edits",
        sources: ["requisites.txt"],
        links: [],
        methods: [],
        skills: ["skills/title.md", "skills/checks.md"],
        checklist: ["Check designation", "Check year"],
        steps: [
          {
            title: "Read",
            instruction: "Read requisites",
            tool: { transport: "mcp", connection: "odn", operation: "read_project" },
            input: "project-id",
          },
        ],
      },
    });
    expect(host.service!.resolve).not.toHaveBeenCalled();
  });

  it("edits project root independently of a document passport", async () => {
    render(<ArtifactMetadataControls workspacePath={workspacePath} path={path} />);
    edit();
    await loadedEditor();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "artifactMetadata.scope" }), {
      key: "ArrowDown",
    });
    fireEvent.click(await screen.findByRole("option", { name: "artifactMetadata.projectScope" }));
    expect(
      (screen.getByLabelText("artifactMetadata.field.purpose") as HTMLTextAreaElement).value,
    ).toBe("");
    fireEvent.change(screen.getByLabelText("artifactMetadata.field.purpose"), {
      target: { value: "Project policy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() => expect(host.service!.save).toHaveBeenCalled());
    expect(host.service!.save).toHaveBeenCalledWith(
      expect.objectContaining({
        path: ".",
        entry: expect.objectContaining({ kind: "folder", purpose: "Project policy" }),
      }),
    );
  });

  it("retains the draft on JSON validation and service failures", async () => {
    vi.mocked(host.service!.save).mockRejectedValue(new Error("Metadata store is read-only"));
    render(<ArtifactMetadataControls workspacePath={workspacePath} path={path} />);
    edit();
    await loadedEditor();
    fireEvent.change(screen.getByLabelText("artifactMetadata.field.instructions"), {
      target: { value: "Keep this draft" },
    });
    fireEvent.change(screen.getByLabelText("artifactMetadata.field.steps"), {
      target: { value: '[{"title":"Missing instruction"}]' },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    expect(screen.getByRole("alert").textContent).toBe("artifactMetadata.invalidSteps");
    expect(host.service!.save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("artifactMetadata.field.steps"), {
      target: { value: "[]" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Metadata store is read-only"),
    );
    expect(
      (screen.getByLabelText("artifactMetadata.field.instructions") as HTMLTextAreaElement).value,
    ).toBe("Keep this draft");
    expect(
      (screen.getByRole("button", { name: "common.save" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("activates without IO and previews fresh context with provenance", async () => {
    const onEnabledChange = vi.fn();
    const view = render(
      <ArtifactMetadataControls
        workspacePath={workspacePath}
        path={path}
        onEnabledChange={onEnabledChange}
      />,
    );
    expect(screen.getByTestId("artifact-context-trigger").textContent).toContain(
      "artifactMetadata.contextOff",
    );
    openMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "artifactMetadata.use" }));
    expect(onEnabledChange).toHaveBeenCalledWith(true);
    expect(host.service!.read).not.toHaveBeenCalled();
    expect(host.service!.resolve).not.toHaveBeenCalled();
    view.rerender(
      <ArtifactMetadataControls
        workspacePath={workspacePath}
        path={path}
        enabled
        onEnabledChange={onEnabledChange}
      />,
    );
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "artifactMetadata.inspect" }));
    await waitFor(() =>
      expect(screen.getByTestId("artifact-context-preview").textContent).toBe(
        "Project instructions",
      ),
    );
    expect(host.service!.resolve).toHaveBeenCalledWith({ workspacePath, path });
    expect(screen.getByText(/rev-1/)).toBeTruthy();
    expect(screen.getByText(/artifactMetadata.historyHelp/)).toBeTruthy();
    vi.mocked(host.service!.resolve).mockResolvedValue({
      path,
      revision: "rev-2",
      entries: [],
      text: "Updated rules",
    });
    fireEvent.click(screen.getByRole("button", { name: "artifactMetadata.refresh" }));
    await waitFor(() =>
      expect(screen.getByTestId("artifact-context-preview").textContent).toBe("Updated rules"),
    );
    expect(screen.getByText(/rev-2/)).toBeTruthy();
  });

  it("shows unavailable host support without requiring a ServiceProvider", () => {
    host.service = undefined;
    render(
      <ArtifactMetadataControls
        workspacePath={workspacePath}
        path={path}
        onEnabledChange={vi.fn()}
      />,
    );
    openMenu();
    expect(screen.getByText("artifactMetadata.unavailable")).toBeTruthy();
    expect(
      screen
        .getByRole("menuitemradio", { name: "artifactMetadata.use" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("shows a read error and prevents overwriting an unreadable passport store", async () => {
    vi.mocked(host.service!.read).mockRejectedValue(new Error("Corrupt metadata"));
    render(<ArtifactMetadataControls workspacePath={workspacePath} path={path} />);
    edit();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Corrupt metadata"));
    expect(
      (screen.getByRole("button", { name: "common.save" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(host.service!.save).not.toHaveBeenCalled();
  });

  it("ignores a pending old workspace read after switching documents", async () => {
    let finishOld!: (entries: ProjectMetadataEntries) => void;
    vi.mocked(host.service!.read).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    const view = render(<ArtifactMetadataControls workspacePath={workspacePath} path={path} />);
    edit();
    await waitFor(() => expect(host.service!.read).toHaveBeenCalledTimes(1));
    view.rerender(<ArtifactMetadataControls workspacePath="D:/other" path={path} />);
    edit();
    await loadedEditor();
    await act(async () => finishOld({ [path]: passport("Wrong project") }));
    expect(
      (screen.getByLabelText("artifactMetadata.field.purpose") as HTMLTextAreaElement).value,
    ).toBe("Title page");
    expect(host.service!.read).toHaveBeenLastCalledWith({ workspacePath: "D:/other" });
  });
});
