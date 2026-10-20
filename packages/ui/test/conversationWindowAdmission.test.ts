// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { afterEach, describe, expect, it, vi } from "vitest";
const { listSessions } = vi.hoisted(() => ({ listSessions: vi.fn() }));
const services = { zcodeAgentService: { listSessions } };
vi.mock("../src/hooks/useServices.js", () => ({ useServices: () => services }));
vi.mock("../src/v4/WorkbenchPane.js", () => ({ WorkbenchLeafPane: () => createElement("div", { "data-admitted-composer": "true" }) }));
import { AdmittedConversation } from "../src/spec-document/ConversationWindowHost.js";
const entry = { id: "saved", scope: { workspacePath: "D:/project-b" }, sessionId: "saved-b1", title: "B1" };
const admission = () => createElement(ZCodeIntlProvider, { initialLocale: "en-US" }, createElement(AdmittedConversation, { entry, routeAction: vi.fn() }));
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => { if (root) await act(async () => root?.unmount()); document.body.innerHTML = ""; vi.clearAllMocks(); });
describe("cold conversation window admission", () => {
  it("reads the exact saved target before admitting a composer, even with no running index", async () => {
    let ready!: (sessions: Array<{ sessionId: string }>) => void;
    listSessions.mockImplementation(() => new Promise<Array<{ sessionId: string }>>(accept => { ready = accept; }));
    const container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(admission()));
    expect(container.querySelector("[data-admitted-composer]")).toBeNull();
    // 上游 3.16.2 从 ZCodeAgentListSessionsParams 移除 includeArchived；按 id 过滤的持久列表调用不再携带该参数。
    expect(listSessions).toHaveBeenCalledWith({ workspacePath: "D:/project-b", sessionIds: ["saved-b1"], limit: 1 });
    await act(async () => ready([{ sessionId: "saved-b1" }]));
    expect(container.querySelector("[data-admitted-composer]")).not.toBeNull();
  });
  it("retains an unavailable target with retry instead of opening another conversation", async () => {
    listSessions.mockRejectedValue(new Error("Project offline"));
    const container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(admission()));
    expect(container.querySelector("[data-admitted-composer]")).toBeNull();
    expect(container.textContent).toContain("Project offline");
    expect(container.textContent).toContain("Retry connection");
    listSessions.mockResolvedValue([{ sessionId: "saved-b1" }]);
    const retry = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Retry connection")!;
    await act(async () => retry.click());
    expect(container.querySelector("[data-admitted-composer]")).not.toBeNull();
  });
});
