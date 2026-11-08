// @vitest-environment jsdom
// Full-view floating widget gains an "open in separate window" menu item
// (2026-11-08, user request: float across all screens, not just inside the
// app window). This pins the host-level contract: the item renders only when
// a detach handler is provided and forwards the click to it. Roster dedupe
// and the detach wiring live in conversationWindows.test.ts and the shell.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  TID_SIDE_PANE_FULL_VIEW_HANDLE,
  TID_SIDE_PANE_FULL_VIEW_MENU_OPEN_CONVERSATION,
  TID_SIDE_PANE_FULL_VIEW_MENU_OPEN_WINDOW,
} from "@zcode/shared/test-ids";
import { SidePaneFullViewConversationHost } from "@/side-pane-full-view/ConversationHost.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

beforeAll(() => {
  // jsdom has no pointer capture; the drag handle calls it on pointerdown.
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

afterEach(cleanup);

function renderHost(props: { onOpenInWindow?: () => void }) {
  const onOpenConversation = vi.fn();
  render(
    <TooltipProvider>
      <SidePaneFullViewConversationHost
        mode="floating"
        floating="expanded"
        anchor="bottom-right"
        slotElement={null}
        onFloatingChange={() => {}}
        onAnchorChange={() => {}}
        onOpenConversation={onOpenConversation}
        {...props}
      >
        <div data-fake-conversation="" />
      </SidePaneFullViewConversationHost>
    </TooltipProvider>,
  );
  return { onOpenConversation };
}

/** Radix skips its own trigger toggle when pointerdown is default-prevented
 * (the drag handle does that), so the menu opens from the pointerup click. */
function openMenu() {
  const handle = screen.getByTestId(TID_SIDE_PANE_FULL_VIEW_HANDLE);
  fireEvent.pointerDown(handle, { button: 0 });
  fireEvent.pointerUp(handle);
}

describe("side-pane full view floating widget: open in separate window", () => {
  it("forwards the menu action to the detach handler", () => {
    const onOpenInWindow = vi.fn();
    renderHost({ onOpenInWindow });
    openMenu();
    fireEvent.click(screen.getByTestId(TID_SIDE_PANE_FULL_VIEW_MENU_OPEN_WINDOW));
    expect(onOpenInWindow).toHaveBeenCalledOnce();
  });

  it("renders the item only when a detach handler is provided", () => {
    const { onOpenConversation } = renderHost({});
    openMenu();
    expect(screen.queryByTestId(TID_SIDE_PANE_FULL_VIEW_MENU_OPEN_WINDOW)).toBeNull();
    // Sibling actions stay intact when the detach entry is absent.
    fireEvent.click(screen.getByTestId(TID_SIDE_PANE_FULL_VIEW_MENU_OPEN_CONVERSATION));
    expect(onOpenConversation).toHaveBeenCalledOnce();
  });
});
