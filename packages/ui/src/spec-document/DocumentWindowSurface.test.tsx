// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocumentWindowSurface } from "./DocumentWindowSurface.js";
import {
  documentSurfacePlacementKey,
  type RetainedDocumentWindow,
} from "./retainedDocumentWindows.js";

const harness = vi.hoisted(() => ({
  popped: false,
  onPoppedChange: (_popped: boolean) => {},
  focus: vi.fn(),
  attach: vi.fn(async () => ({ attached: true })),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => ({
    openConversationPopout: vi.fn(),
    setConversationWindowAttachment: harness.attach,
  }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));
vi.mock("./conversationWindows.js", () => ({
  useConversationWindows: () => [],
  conversationWindowKey: () => "parent",
}));
vi.mock("./specPopoutRegion.js", () => ({
  useSpecPopoutRegion: (options: {
    onPoppedChange: (popped: boolean) => void;
  }) => {
    harness.onPoppedChange = options.onPoppedChange;
    return {
      popped: harness.popped,
      focus: harness.focus,
      open: vi.fn(),
      anchorRef: { current: null },
      lastError: null,
    };
  },
  SpecPopoutRegionPortal: ({ children }: { children: ReactNode }) => children,
}));
const entry: RetainedDocumentWindow = {
  workspacePath: "D:/source",
  parentSessionId: "parent",
  tab: {
    id: "doc-a",
    type: "code-viewer",
    sourceKey: null,
    source: {
      type: "file",
      title: "a.md",
      path: "D:/source/a.md",
      workspacePath: "D:/source",
      specDocument: true,
    },
  },
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  harness.popped = false;
  harness.attach.mockClear();
  harness.focus.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it("retains the addressed owner before native open resolves and while either surface is open", async () => {
  const retain = vi.fn();
  let discussion: (popped: boolean) => void = () => {};
  await act(async () =>
    root.render(
      <DocumentWindowSurface
        entry={entry}
        visible={false}
        onRetainedChange={retain}
        onAttachmentChange={() => {}}
        onActivate={() => {}}
      >
        {(_visible, onDiscussion) => {
          discussion = onDiscussion;
          return <div />;
        }}
      </DocumentWindowSurface>,
    ),
  );
  expect(retain).toHaveBeenLastCalledWith(true);
  await act(async () => {
    discussion(true);
    harness.onPoppedChange(false);
  });
  expect(retain).toHaveBeenLastCalledWith(true);
  await act(async () => discussion(false));
  expect(retain).toHaveBeenLastCalledWith(false);
});
it("a returned document stays returned on remount and sidebar reveal cannot reopen it", async () => {
  localStorage.setItem(
    `zcode-popout-open:v1:${documentSurfacePlacementKey(entry)}`,
    "false",
  );
  const retain = vi.fn();
  await act(async () =>
    root.render(
      <DocumentWindowSurface
        entry={entry}
        visible={false}
        onRetainedChange={retain}
        onAttachmentChange={() => {}}
        onActivate={() => {}}
      >
        {(visible) => <div data-visible={String(visible)} />}
      </DocumentWindowSurface>,
    ),
  );
  expect(retain).not.toHaveBeenCalled();
  expect(
    container.querySelector("[data-visible]")?.getAttribute("data-visible"),
  ).toBe("false");
  expect(
    localStorage.getItem(
      `zcode-popout-open:v1:${documentSurfacePlacementKey(entry)}`,
    ),
  ).toBe("false");
});
it("whole-document visibility follows its native surface when the main project is inactive", async () => {
  harness.popped = true;
  await act(async () =>
    root.render(
      <DocumentWindowSurface
        entry={entry}
        visible={false}
        onRetainedChange={() => {}}
        onAttachmentChange={() => {}}
        onActivate={() => {}}
      >
        {(visible) => <div data-visible={String(visible)} />}
      </DocumentWindowSurface>,
    ),
  );
  expect(
    container.querySelector("[data-visible]")?.getAttribute("data-visible"),
  ).toBe("true");
  expect(harness.attach).toHaveBeenCalledWith(
    expect.objectContaining({
      documentId: documentSurfacePlacementKey(entry),
      conversationId: null,
    }),
  );
});
it("managed discussion activation focuses its whole-document window instead of the hidden main anchor", async () => {
  harness.popped = true;
  const activateOwner = vi.fn();
  let activateDocument: () => void = () => {};
  await act(async () =>
    root.render(
      <DocumentWindowSurface
        entry={entry}
        visible={false}
        onRetainedChange={() => {}}
        onAttachmentChange={() => {}}
        onActivate={activateOwner}
      >
        {(_visible, _discussion, activate) => {
          activateDocument = activate;
          return <div />;
        }}
      </DocumentWindowSurface>,
    ),
  );
  await act(async () => activateDocument());
  expect(harness.focus).toHaveBeenCalledTimes(1);
  expect(activateOwner).not.toHaveBeenCalled();
});
