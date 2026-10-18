import type { ConversationDisplay, ConversationRectangle } from "./nativeConversationGeometry.js";

export interface AttachableWindow {
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
  getBounds(): ConversationRectangle;
  setBounds(bounds: ConversationRectangle): void;
  on(event: string, listener: () => void): unknown;
}

interface Entry { window: AttachableWindow; last: ConversationRectangle; ready: boolean; suspended: boolean }
interface Pair { document: string; conversation: string; side: "left" | "right" }
const equal = (a: ConversationRectangle, b: ConversationRectangle) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const active = (win: AttachableWindow) => !win.isDestroyed() && !win.isMaximized()
  && !win.isMinimized() && !win.isFullScreen();

/** Main owns native relationships only; durable desired pairing belongs to the UI. */
export class NativeWindowAttachments {
  private readonly windows = new Map<string, Entry>();
  private readonly pairs = new Map<string, Pair>();

  constructor(private readonly displays: () => readonly ConversationDisplay[]) {}

  ready(name: string): void {
    const entry = this.windows.get(name);
    if (!entry || entry.window.isDestroyed()) return;
    entry.last = entry.window.getBounds();
    entry.ready = true;
    for (const pair of this.pairs.values()) {
      if (pair.document === name || pair.conversation === name) this.place(pair);
    }
  }

  register(name: string, window: AttachableWindow, ready = true): void {
    const entry = { window, last: window.getBounds(), ready, suspended: false };
    this.windows.set(name, entry);
    for (const event of ["move", "resize", "restore", "unmaximize", "leave-full-screen"]) {
      window.on(event, () => {
        if (this.windows.get(name) !== entry || window.isDestroyed()) return;
        const previous = entry.last;
        const current = window.getBounds();
        // setBounds emits asynchronous move/resize events. Update last BEFORE
        // applying native bounds so those acknowledgements cannot feed back.
        entry.last = current;
        if (!active(window)) { entry.suspended = true; return; }
        const resumed = entry.suspended || event !== "move" && event !== "resize";
        entry.suspended = false;
        if (equal(previous, current) && (event === "move" || event === "resize")) return;
        for (const pair of this.pairs.values()) {
          if (pair.document === name || pair.conversation === name) {
            this.place(pair, resumed ? undefined : name, resumed ? undefined : previous);
          }
        }
      });
    }
    window.on("closed", () => {
      if (this.windows.get(name) !== entry) return;
      this.windows.delete(name);
      this.pairs.delete(name);
      // Keep a document's desired target pending when only its conversation
      // closes. Closing the document itself drops the ephemeral relation; the
      // UI replays its current durable choice after any future reopening.
    });
    for (const pair of this.pairs.values()) {
      if (pair.document === name || pair.conversation === name) this.place(pair);
    }
  }

  set(document: string, conversation: string | null, side: "left" | "right" = "right"): boolean {
    if (conversation === null) { this.pairs.delete(document); return false; }
    if (!this.windows.has(document)) return false;
    if (document === conversation || this.pairs.size >= 50 && !this.pairs.has(document)) return false;
    // No chains/cycles: each native surface belongs to at most one pair.
    for (const [key, pair] of this.pairs) {
      if (key !== document && (pair.document === conversation || pair.conversation === document
        || pair.conversation === conversation)) this.pairs.delete(key);
    }
    // A live document is required. A target can be pending during cold restore;
    // the owner-scoped registry prevents resolving another owner's window.
    const existing = this.pairs.get(document);
    if (existing?.conversation === conversation && existing.side === side) return true;
    const pair = { document, conversation, side };
    this.pairs.set(document, pair);
    this.place(pair);
    return true;
  }

  private place(pair: Pair, moved?: string, previous?: ConversationRectangle): void {
    const doc = this.windows.get(pair.document);
    const chat = this.windows.get(pair.conversation);
    if (!doc?.ready || !chat?.ready || !active(doc.window) || !active(chat.window)) return;
    const d = doc.window.getBounds();
    const c = chat.window.getBounds();
    let nextChat = { ...c };
    let nextDoc = { ...d };
    if (moved === pair.document && previous) {
      nextChat.x += d.x - previous.x;
      nextChat.y += d.y - previous.y;
      // Document left-edge resizing keeps the common adjacent edge intact.
      nextChat.x = pair.side === "right" ? d.x - c.width : d.x + d.width;
    } else {
      nextDoc.x = pair.side === "right" ? c.x + c.width : c.x - d.width;
      const alreadyAdjacent = Math.abs(d.x - nextDoc.x) <= 2;
      nextDoc.y = moved === pair.conversation && previous ? d.y + c.y - previous.y
        : alreadyAdjacent ? d.y : c.y;
    }
    const combined = () => ({
      x: Math.min(nextDoc.x, nextChat.x), y: Math.min(nextDoc.y, nextChat.y),
      width: nextDoc.width + nextChat.width,
      height: Math.max(nextDoc.y + nextDoc.height, nextChat.y + nextChat.height) - Math.min(nextDoc.y, nextChat.y),
    });
    const areas = this.displays().map(display => display.workArea);
    const group = combined();
    const area = areas.filter(a => a.width >= group.width && a.height >= group.height)
      .sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y))[0];
    // Suspend if a pair cannot fit; never push a partner beyond every work area.
    if (!area) return;
    if (!moved && pair.side === "right" && nextDoc.x + nextDoc.width > area.x + area.width
      && c.x - d.width >= area.x) {
      pair.side = "left";
      nextDoc.x = c.x - d.width;
      if (Math.abs(d.x - nextDoc.x) <= 2) nextDoc.y = d.y;
    }
    const bounds = combined();
    const dx = Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width) - bounds.x;
    const dy = Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height) - bounds.y;
    nextChat = { ...nextChat, x: nextChat.x + dx, y: nextChat.y + dy };
    nextDoc = { ...nextDoc, x: nextDoc.x + dx, y: nextDoc.y + dy };
    for (const [entry, next] of [[chat, nextChat], [doc, nextDoc]] as const) {
      entry.last = next;
      if (!equal(entry.window.getBounds(), next)) entry.window.setBounds(next);
    }
  }
}
