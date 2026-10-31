/**
 * U-19：文档 tab 的「文内查找」DOM 侧——收集渲染正文里的命中区间并用 CSS Custom
 * Highlight API 上色。模式与 conversationFindHighlightDom.ts 同源（设计令牌
 * --color-find-highlight / -active，active 高亮 priority 更高），但面向整块文档
 * 正文容器（无虚拟行），并跳过交互元素与查找条自身。
 */
export const DOC_FIND_HIGHLIGHT_NAME = "zcode-doc-find";
export const ACTIVE_DOC_FIND_HIGHLIGHT_NAME = "zcode-doc-find-active";

const DOC_FIND_STYLE_ID = "zcode-doc-find-highlight-style";
const DOC_FIND_HIGHLIGHT_STYLE = `
::highlight(${DOC_FIND_HIGHLIGHT_NAME}) {
  background-color: var(--color-find-highlight, #fde68a);
  color: var(--color-foreground);
}
::highlight(${ACTIVE_DOC_FIND_HIGHLIGHT_NAME}) {
  background-color: var(--color-find-highlight-active, #facc15);
  color: var(--color-foreground);
}
`;

interface CssHighlightRegistryLike {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
}

type CssHighlightLike = { priority?: number };
type HighlightConstructor = new (...ranges: Range[]) => unknown;

function getCssHighlightSupport(): {
  highlights: CssHighlightRegistryLike;
  Highlight: HighlightConstructor;
} | null {
  if (typeof window === "undefined" || typeof CSS === "undefined") {
    return null;
  }
  const highlights = (CSS as unknown as { highlights?: CssHighlightRegistryLike }).highlights;
  const Highlight = (window as unknown as { Highlight?: HighlightConstructor }).Highlight;
  if (!highlights || !Highlight) {
    return null;
  }
  return { highlights, Highlight };
}

export function ensureDocumentFindHighlightStyle(): void {
  if (typeof document === "undefined") {
    return;
  }
  const style = document.getElementById(DOC_FIND_STYLE_ID) ?? document.createElement("style");
  style.id = DOC_FIND_STYLE_ID;
  if (style.textContent !== DOC_FIND_HIGHLIGHT_STYLE) {
    // 开发态 HMR 会复用旧 style 节点；内容变化时必须同步更新。
    style.textContent = DOC_FIND_HIGHLIGHT_STYLE;
  }
  if (!style.isConnected) {
    document.head.append(style);
  }
}

function shouldSkipTextNode(textNode: Text): boolean {
  const parent = textNode.parentElement;
  if (!parent) {
    return true;
  }
  return Boolean(
    parent.closest(
      'button,input,textarea,select,[contenteditable="true"],[data-doc-find-ignore="true"]',
    ),
  );
}

/** 收集容器内全部命中的 Range（大小写不敏感子串；跳过交互元素）。 */
export function collectDocumentFindRanges(root: HTMLElement, normalizedQuery: string): Range[] {
  if (!normalizedQuery) {
    return [];
  }
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text) || shouldSkipTextNode(node)) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.data.toLocaleLowerCase().includes(normalizedQuery)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });
  let currentNode = walker.nextNode();
  while (currentNode) {
    const textNode = currentNode as Text;
    const normalizedText = textNode.data.toLocaleLowerCase();
    let searchStart = 0;
    while (searchStart < normalizedText.length) {
      const matchIndex = normalizedText.indexOf(normalizedQuery, searchStart);
      if (matchIndex === -1) {
        break;
      }
      const range = document.createRange();
      range.setStart(textNode, matchIndex);
      range.setEnd(textNode, matchIndex + normalizedQuery.length);
      ranges.push(range);
      searchStart = matchIndex + normalizedQuery.length;
    }
    currentNode = walker.nextNode();
  }
  return ranges;
}

/** 上色并返回当前命中（无 CSS Highlight 支持时仍返回活动区间，供滚动定位）。 */
export function applyDocumentFindHighlights({
  root,
  query,
  activeIndex,
}: {
  root: HTMLElement;
  query: string;
  activeIndex: number;
}): { ranges: Range[]; activeRange: Range | null } {
  ensureDocumentFindHighlightStyle();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const ranges = collectDocumentFindRanges(root, normalizedQuery);
  const activeRange =
    ranges.length > 0
      ? (ranges[Math.max(0, Math.min(activeIndex, ranges.length - 1))] ?? null)
      : null;
  const support = getCssHighlightSupport();
  if (support) {
    const create = (highlightRanges: Range[], priority: number) => {
      const highlight = new support.Highlight(...highlightRanges) as CssHighlightLike;
      highlight.priority = priority;
      return highlight;
    };
    support.highlights.set(DOC_FIND_HIGHLIGHT_NAME, create(ranges, 0));
    support.highlights.set(
      ACTIVE_DOC_FIND_HIGHLIGHT_NAME,
      create(activeRange ? [activeRange] : [], 1),
    );
  }
  return { ranges, activeRange };
}

export function scrollDocumentFindRangeIntoView(range: Range): void {
  const container = range.commonAncestorContainer;
  const element = container instanceof Element ? container : container.parentElement;
  element?.scrollIntoView({ block: "center", behavior: "auto" });
}

export function clearDocumentFindHighlights(): void {
  const support = getCssHighlightSupport();
  support?.highlights.delete(DOC_FIND_HIGHLIGHT_NAME);
  support?.highlights.delete(ACTIVE_DOC_FIND_HIGHLIGHT_NAME);
}

/** 编辑模式：textarea 缓冲内全部命中的起始偏移（大小写不敏感子串）。 */
export function findTextareaMatchOffsets(content: string, query: string): number[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  const normalizedContent = content.toLocaleLowerCase();
  const offsets: number[] = [];
  let searchStart = 0;
  while (searchStart <= normalizedContent.length - normalizedQuery.length) {
    const matchIndex = normalizedContent.indexOf(normalizedQuery, searchStart);
    if (matchIndex === -1) {
      break;
    }
    offsets.push(matchIndex);
    searchStart = matchIndex + normalizedQuery.length;
  }
  return offsets;
}
