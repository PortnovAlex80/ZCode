import { expect, test } from "vitest";
import { documentFirstInputBody } from "../src/v4/documentFirstInput.js";

test("document context wraps native plan task text instead of restoring its shortcut token", () => {
  expect(documentFirstInputBody("/plan explain this paragraph")).toBe("explain this paragraph");
  expect(documentFirstInputBody("explain this paragraph")).toBe("explain this paragraph");
});
test("native controls keep their admission path and never become contextual prompts", () => {
  expect(documentFirstInputBody("/plan")).toBeUndefined();
  expect(documentFirstInputBody("/compact")).toBeUndefined();
  expect(documentFirstInputBody("/plan task", [], { contextAttachmentCount: 1 })).toBeUndefined();
});
