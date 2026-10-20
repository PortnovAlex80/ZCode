import assert from "node:assert/strict";
import { test } from "vitest";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import {
  applySpecGeneralChatColumn,
  canCollapseSpecGeneralChat,
  resolveSpecGeneralChatCollapsed,
  specGeneralChatLayoutId,
  specGeneralChatLeafPresentation,
  transitionSpecGeneralChatLayout,
  toggleSpecGeneralChatCollapse,
} from "./specGeneralChatCollapse.js";

const documentContext = {
  workspaceKey: "workspace-a",
  documentActive: true,
  sidePaneOpen: true,
  workspaceMainView: "chat",
};

test("general chat collapse is opt-in and restores outside the granted document context", () => {
  assert.equal(resolveSpecGeneralChatCollapsed(null, documentContext), false);
  const requested = toggleSpecGeneralChatCollapse(null, documentContext);
  assert.equal(requested, "workspace-a");
  assert.equal(
    resolveSpecGeneralChatCollapsed(requested, documentContext),
    true,
  );
  assert.equal(toggleSpecGeneralChatCollapse(requested, documentContext), null);
  for (const change of [
    { workspaceKey: "workspace-b" },
    { documentActive: false },
    { sidePaneOpen: false },
    { workspaceMainView: "automations" },
    { workspaceMainView: "plugin-store" },
  ]) {
    const context = { ...documentContext, ...change };
    assert.equal(resolveSpecGeneralChatCollapsed(requested, context), false);
    if (context.workspaceKey === "workspace-a") {
      assert.equal(canCollapseSpecGeneralChat(context), false);
      assert.equal(toggleSpecGeneralChatCollapse(null, context), null);
    }
  }
});

test("a hidden chat retains only its selected config-source owner, without input focus or dialogs", () => {
  const hidden = {
    foregroundEnabled: false,
    interactionDialogsVisible: false,
    keepSpecExecutionSource: true,
  };
  assert.deepEqual(
    specGeneralChatLeafPresentation({ ...hidden, selected: true }),
    {
      focused: false,
      telemetryVisible: false,
      interactionDialogsVisible: false,
      keepSpecExecutionSource: true,
    },
  );
  assert.deepEqual(
    specGeneralChatLeafPresentation({ ...hidden, selected: false }),
    {
      focused: false,
      telemetryVisible: false,
      interactionDialogsVisible: false,
      keepSpecExecutionSource: false,
    },
  );
  assert.equal(
    specGeneralChatLeafPresentation({
      ...hidden,
      selected: true,
      keepSpecExecutionSource: false,
    }).keepSpecExecutionSource,
    false,
  );
  assert.equal(
    specGeneralChatLeafPresentation({
      ...hidden,
      selected: true,
      foregroundEnabled: true,
      interactionDialogsVisible: true,
      keepSpecExecutionSource: false,
    }).focused,
    true,
  );
});

test("collapse and repeated requests preserve the prior native column size for restoration", () => {
  let collapsed = false;
  let size = 52;
  const calls: string[] = [];
  const panel = {
    getSize: () => ({ asPercentage: size }),
    isCollapsed: () => collapsed,
    collapse: () => {
      calls.push("collapse");
      collapsed = true;
      size = 0;
    },
    expand: () => {
      calls.push("expand");
      collapsed = false;
      size = 35;
    },
    resize: (next: string) => {
      calls.push(next);
      size = Number.parseFloat(next);
      collapsed = false;
    },
  };
  const memory = { expandedSize: null as number | null };
  applySpecGeneralChatColumn(panel, true, memory);
  applySpecGeneralChatColumn(panel, true, memory);
  assert.equal(size, 0);
  assert.equal(memory.expandedSize, 52);
  applySpecGeneralChatColumn(panel, false, memory);
  applySpecGeneralChatColumn(panel, false, memory);
  assert.equal(size, 52);
  assert.equal(memory.expandedSize, null);
  assert.deepEqual(calls, ["collapse", "52%"]);
});

test("Spec layout preferences have a separate namespace and ordinary ZCODE remains unchanged", () => {
  assert.equal(
    specGeneralChatLayoutId("workspace-a", false),
    "workspace-body-layout",
  );
  assert.notEqual(
    specGeneralChatLayoutId("workspace-a", true),
    "workspace-body-layout",
  );
  assert.notEqual(
    specGeneralChatLayoutId("workspace-a", true),
    specGeneralChatLayoutId("workspace-b", true),
  );
});

test("same-panel Group layouts restore before leaving the Spec persistence namespace", () => {
  let current = { "conversation-column": 52, browser: 48 };
  const group = {
    getLayout: () => current,
    setLayout: (layout: Record<string, number>) => {
      current = { ...layout } as typeof current;
    },
  };
  const memory = {
    workspaceKey: null as string | null,
    ordinaryLayout: null as Record<string, number> | null,
  };
  const columnMemory = { expandedSize: null as number | null };
  transitionSpecGeneralChatLayout(group, "workspace-a", memory, columnMemory);
  current = { "conversation-column": 41, browser: 59 };
  transitionSpecGeneralChatLayout(group, "workspace-a", memory, columnMemory);
  columnMemory.expandedSize = 41;
  current = { "conversation-column": 0, browser: 100 };
  transitionSpecGeneralChatLayout(group, null, memory, columnMemory);
  assert.deepEqual(current, { "conversation-column": 52, browser: 48 });
  assert.equal(columnMemory.expandedSize, null);
  assert.equal(memory.ordinaryLayout, null);
  transitionSpecGeneralChatLayout(group, "workspace-b", memory, columnMemory);
  current = { "conversation-column": 35, browser: 65 };
  transitionSpecGeneralChatLayout(group, null, memory, columnMemory);
  assert.deepEqual(current, { "conversation-column": 52, browser: 48 });
});

// U-03 5.2a（用户 2026-10-14 实机回归）：RRP 的 setLayout 按值的位置解释布局，
// 恢复一个旧排列 key 顺序的 ordinaryLayout 会让槽位错位、此后分隔条拖拽/键盘
// 方向颠倒。transition 必须先按当前注册表顺序重排（每个 panelId 的值不变）。
test("layout restore is re-keyed to the group's current panel order (5.2a)", () => {
  const setLayoutCalls: Array<string[]> = [];
  let current: Record<string, number> = {
    browser: 62,
    "conversation-column": 38,
  };
  const group = {
    getLayout: () => current,
    setLayout: (layout: Record<string, number>) => {
      setLayoutCalls.push(Object.keys(layout));
      current = { ...layout };
    },
  };
  const memory = {
    workspaceKey: null as string | null,
    // 在 chat-center（旧排列）下捕获：key 顺序 [conversation-column, browser]。
    ordinaryLayout: { "conversation-column": 52, browser: 48 } as Record<
      string,
      number
    > | null,
  };
  transitionSpecGeneralChatLayout(group, "workspace-a", memory, {
    expandedSize: null,
  });
  // 恢复到 document-center 注册表顺序 [browser, conversation-column]，值按 id 保持。
  assert.deepEqual(setLayoutCalls, [["browser", "conversation-column"]]);
  assert.deepEqual(current, { browser: 48, "conversation-column": 52 });

  // 组不可见（defaultLayoutDeferred ⇒ getLayout 为空）时原样传递，不猜顺序。
  const deferredGroup = {
    getLayout: () => ({}) as Record<string, number>,
    setLayout: (layout: Record<string, number>) => {
      setLayoutCalls.push(Object.keys(layout));
    },
  };
  setLayoutCalls.length = 0;
  transitionSpecGeneralChatLayout(
    deferredGroup,
    "workspace-b",
    {
      workspaceKey: null,
      ordinaryLayout: { "conversation-column": 52, browser: 48 },
    },
    { expandedSize: null },
  );
  assert.deepEqual(setLayoutCalls, [["conversation-column", "browser"]]);
});

function descendants(
  root: ts.Node,
  predicate: (node: ts.Node) => boolean,
): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}
async function parse(path: string) {
  const text = await readFile(new URL(path, import.meta.url), "utf8");
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}
function prop(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
  source: ts.SourceFile,
) {
  return node.attributes.properties
    .find(
      (attribute) =>
        ts.isJsxAttribute(attribute) && attribute.name.getText(source) === name,
    )
    ?.getText(source)
    .replace(/\s+/g, " ")
    .replace(/\{ /g, "{")
    .replace(/ \}/g, "}");
}

test("actual shell keeps conversation controllers mounted, collapses only their column and preserves navigation", async () => {
  const source = await parse("../app-shell/WorkspaceShellLayout.tsx");
  const panels = descendants(
    source,
    (node) =>
      ts.isJsxOpeningElement(node) &&
      node.tagName.getText(source) === "ResizablePanel",
  ) as ts.JsxOpeningElement[];
  const column = panels.find(
    (node) => prop(node, "id", source) === 'id="conversation-column"',
  );
  assert.ok(column);
  assert.equal(
    prop(column, "collapsible", source),
    "collapsible={generalChatCollapsed}",
  );
  assert.equal(prop(column, "collapsedSize", source), 'collapsedSize="0px"');
  assert.equal(prop(column, "inert", source), "inert={generalChatCollapsed}");
  const parent = column.parent;
  assert.ok(ts.isJsxElement(parent));
  assert.equal(
    descendants(
      parent,
      (node) =>
        ts.isJsxSelfClosingElement(node) &&
        node.tagName.getText(source) === "V4WorkspaceChatArea",
    ).length,
    1,
  );
  assert.equal(
    descendants(
      parent,
      (node) =>
        ts.isJsxSelfClosingElement(node) &&
        node.tagName.getText(source) === "WorkspaceSidebar",
    ).length,
    0,
  );
  const conditionalAncestors: ts.Node[] = [];
  for (let node: ts.Node | undefined = column; node; node = node.parent) {
    if (
      ts.isConditionalExpression(node) &&
      node.condition.getText(source).includes("generalChatCollapsed")
    )
      conditionalAncestors.push(node);
  }
  assert.equal(
    conditionalAncestors.length,
    0,
    "collapse never unmounts the native chat controller",
  );
  const chat = descendants(
    parent,
    (node) =>
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(source) === "V4WorkspaceChatArea",
  )[0] as ts.JsxSelfClosingElement;
  assert.equal(
    prop(chat, "foregroundEnabled", source),
    "foregroundEnabled={isWorkspaceVisible && !generalChatCollapsed}",
  );
  assert.equal(
    prop(chat, "interactionDialogsVisible", source),
    "interactionDialogsVisible={!generalChatCollapsed}",
  );
  assert.equal(
    prop(chat, "keepSpecExecutionSource", source),
    "keepSpecExecutionSource={isWorkspaceVisible && generalChatCollapsed}",
  );
  const group = descendants(
    source,
    (node) =>
      ts.isJsxOpeningElement(node) &&
      node.tagName.getText(source) === "ResizablePanelGroup" &&
      prop(node, "groupRef", source) === "groupRef={generalChatGroupRef}",
  )[0] as ts.JsxOpeningElement;
  assert.equal(prop(group, "key", source), undefined);
  const report = descendants(
    source,
    (node) =>
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "handleSpecDocumentActiveChange",
  )[0];
  assert.ok(report);
  assert.ok(
    report.getText(source).indexOf("transitionSpecGeneralChatLayout(") <
      report.getText(source).indexOf("setSpecDocumentActiveState("),
  );
  assert.match(report.getText(source), /active && isWorkspaceVisible/);
});

test("actual native publisher preserves scope exclusions when the selected main chat is hidden", async () => {
  const source = await parse("../v4/SessionPane.tsx");
  const call = descendants(
    source,
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "usePublishNativeExecutionSource",
  )[0];
  assert.ok(call && ts.isCallExpression(call));
  const expression = call.arguments[1]!.getText(source);
  const evaluate = new Function(
    "specDocumentService",
    "isDesktop",
    "remoteSessionId",
    "selectionSideChat",
    "readOnly",
    "focused",
    "telemetryVisible",
    "keepSpecExecutionSource",
    `return ${expression}`,
  ) as (...values: unknown[]) => boolean;
  const hidden: unknown[] = [
    true,
    true,
    null,
    false,
    false,
    false,
    false,
    true,
  ];
  assert.equal(evaluate(...hidden), true);
  for (const [index, value] of [
    [0, false],
    [1, false],
    [2, "remote"],
    [3, true],
    [4, true],
    [7, false],
  ] as const) {
    const blocked = [...hidden];
    blocked[index] = value;
    assert.equal(evaluate(...blocked), false);
  }
  assert.equal(
    evaluate(true, true, null, false, false, true, true, false),
    true,
  );
  const wrapper = await parse("../v4/WorkbenchPane.tsx");
  const native = descendants(
    wrapper,
    (node) =>
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(wrapper) === "SessionPane",
  )[0] as ts.JsxSelfClosingElement;
  assert.equal(
    prop(native, "keepSpecExecutionSource", wrapper),
    "keepSpecExecutionSource={keepSpecExecutionSource && isShellWorkspace && !readOnly}",
  );
});

test("actual side panel keeps a restore route in the caption and relaxes bounds only while collapsed", async () => {
  const source = await parse("../app-shell/AnimatedSidePanePanel.tsx");
  const captionSource = await parse(
    "../app-shell/WorkspaceSidePaneCaptionControls.tsx",
  );
  // U-04 迁移：SpecDocumentPane 不再持有聊天显隐 props——⤢ «Развернуть документ» 已并入
  // tabs caption 的角色开关；文档头不再出现位置相关的聊天控制。
  const documentPane = descendants(
    source,
    (node) =>
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(source) === "SpecDocumentPane",
  )[0] as ts.JsxSelfClosingElement;
  // U-04 迁移 + 文档窗口化：SpecDocumentPane 的 onActivate 走 DocumentWindowSurface 的
  // render-prop（activateDocument：popout 时聚焦窗口，否则走宿主 onActivate 恢复路由）。
  // 恢复路由仍存在，只是换了接线：宿主 onActivate 经 returnDocument 把保留文档写回
  // 任务记忆并广播 activateRetainedDocument 激活事件（不再直接调用 onActivateTab）。
  assert.equal(
    prop(documentPane, "onActivate", source),
    "onActivate={activateDocument}",
  );
  const documentSurface = descendants(
    source,
    (node) =>
      ts.isJsxOpeningElement(node) &&
      node.tagName.getText(source) === "DocumentWindowSurface",
  )[0] as ts.JsxOpeningElement;
  assert.match(
    prop(documentSurface, "onActivate", source) ?? "",
    /returnDocument\(documentContext!\)/,
  );
  const returnDocumentDecl = descendants(
    source,
    (node) =>
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "returnDocument",
  )[0];
  assert.ok(returnDocumentDecl, "restore route must call returnDocument");
  assert.match(returnDocumentDecl.getText(source), /upsertDocumentWindowTab\(/);
  assert.match(
    returnDocumentDecl.getText(source),
    /activateRetainedDocument\(entry\)/,
  );
  assert.equal(prop(documentPane, "generalChatCollapsed", source), undefined);
  assert.equal(prop(documentPane, "onToggleGeneralChat", source), undefined);
  const panel = descendants(
    source,
    (node) =>
      ts.isJsxOpeningElement(node) &&
      node.tagName.getText(source) === "ResizablePanel",
  )[0] as ts.JsxOpeningElement;
  assert.equal(
    prop(panel, "maxSize", source),
    'maxSize={generalChatCollapsed ? "100%" : panelLayout.maxSize}',
  );
  // 恢复入口：caption 控制簇中的统一角色开关（有区域被隐藏时优先恢复，U-05 restore-first）。
  const captionToggle = descendants(
    captionSource,
    (node) =>
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(captionSource) === "WorkspaceSidePaneToggleButton",
  )[0] as ts.JsxOpeningElement;
  assert.ok(
    captionToggle,
    "caption controls must render the unified role toggle",
  );
  assert.equal(
    prop(captionToggle, "isSidePaneOpen", captionSource),
    "isSidePaneOpen={!roleToggle.targetHidden}",
  );
  assert.equal(
    prop(captionToggle, "onToggleSidePane", captionSource),
    "onToggleSidePane={roleToggle.onToggle}",
  );
  assert.equal(
    prop(captionToggle, "disabled", captionSource),
    "disabled={roleToggle.disabled}",
  );
  const headerControls = descendants(
    source,
    (node) =>
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "sidePaneCaptionControls",
  )[0];
  assert.ok(headerControls);
  assert.match(
    headerControls.getText(source),
    /WorkspaceSidePaneCaptionControls/,
  );
});

test("discussion activation uses the native reveal-and-reuse entry without changing general chat", async () => {
  const source = await parse("../hooks/useAppPanels.ts");
  const handler = descendants(
    source,
    (node) =>
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "handleOpenCodeViewer",
  )[0];
  assert.ok(handler);
  const text = handler.getText(source);
  assert.ok(
    text.indexOf("revealSidePaneForCurrentOwner()") <
      text.indexOf("commitOpenedSidePaneState("),
  );
  assert.match(
    text,
    /openCodeViewerSidePane\(current, source, sidePaneOwnerIdRef.current\)/,
  );
  assert.doesNotMatch(
    text,
    /setActiveTask|onSessionCreated|createSession|sendConversationCommand/,
  );
  const sidePane = await parse("../lib/workspaceSidePane.ts");
  const open = descendants(
    sidePane,
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "openCodeViewerSidePane",
  )[0];
  const activate = descendants(
    sidePane,
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "activateSidePaneTab",
  )[0];
  assert.ok(open && activate);
  assert.match(open.getText(sidePane), /tab.sourceKey === nextTab.sourceKey/);
  assert.match(
    activate.getText(sidePane),
    /findTabIndexById\(current.tabs, tab.id\)/,
  );
  assert.match(activate.getText(sidePane), /nextTabs\[existingIndex\] = tab/);
});

test("actual Workbench admission guard prevents a second managed discussion controller from mounting", async () => {
  const source = await parse("../v4/WorkbenchPane.tsx");
  const native = descendants(
    source,
    (node) =>
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(source) === "SessionPane",
  );
  assert.equal(native.length, 1);
  assert.ok(ts.isJsxElement(native[0]!.parent));
  assert.equal(
    (native[0]!.parent as ts.JsxElement).openingElement.tagName.getText(source),
    "SpecManagedSessionGuard",
  );
  const declaration = descendants(
    source,
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "SpecManagedSessionGuard",
  )[0];
  assert.ok(declaration);
  const compiled = ts.transpileModule(
    `${declaration.getText(source)}\nexport default SpecManagedSessionGuard;`,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  type GuardProps = {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string | null;
    remoteSessionId?: string;
    children: ReactNode;
  };
  const exported: { default?: (props: GuardProps) => ReactNode } = {};
  let managed: { ownerToken: symbol | null } | null = null;
  const lookups: (string | null | undefined)[][] = [];
  const lookup = (
    path: string,
    identity: string | undefined,
    sessionId: string | null,
  ) => {
    lookups.push([path, identity, sessionId]);
    return sessionId === "managed-child" ? managed : null;
  };
  const Button = ({
    children,
    disabled,
  }: {
    children: ReactNode;
    disabled?: boolean;
  }) => createElement("button", { disabled }, children);
  new Function(
    "exports",
    "require",
    "useManagedNativeDiscussionOwner",
    "activateManagedNativeDiscussionOwner",
    "useConversationWindows",
    "findConversationWindow",
    "focusConversationWindow",
    "useIntl",
    "Button",
    compiled,
  )(exported, createRequire(import.meta.url), lookup, () => true, () => [], () => undefined, () => {}, () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }), Button);
  assert.ok(exported.default);
  let mounts = 0;
  const Controller = () => {
    mounts++;
    return createElement("article", null, "native composer");
  };
  const render = (sessionId: string | null, remoteSessionId?: string) =>
    renderToStaticMarkup(
      createElement(exported.default!, {
        workspacePath: "local-project",
        workspaceIdentity: "workspace-a",
        sessionId,
        remoteSessionId,
        children: createElement(Controller),
      }),
    );
  managed = { ownerToken: Symbol("owner") };
  const ownerView = render("managed-child");
  assert.equal(mounts, 0);
  assert.match(ownerView, /Open existing discussion/);
  assert.doesNotMatch(ownerView, /native composer/);
  managed = { ownerToken: null };
  const closedOwnerView = render("managed-child");
  assert.match(closedOwnerView, /Reopen its document/);
  assert.doesNotMatch(closedOwnerView, /disabled/, "a saved discussion can reopen without a mounted owner");
  assert.equal(mounts, 0);
  for (const sessionId of ["ordinary-session", null, "__draft__"])
    render(sessionId);
  render("managed-child", "remote-endpoint");
  assert.equal(mounts, 4);
  assert.deepEqual(lookups.at(-1), ["local-project", "workspace-a", null]);
});
