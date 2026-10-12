import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPreviewState,
  addDiscussion,
  deleteDiscussion,
  activeMessages,
  sendPreview,
} from "./model.js";

test("fragment discussions isolate messages and deletion returns to document", () => {
  const state = createPreviewState();
  assert.equal(addDiscussion(state, "empty"), false);
  sendPreview(state, "main draft");
  state.selected = "selected paragraph";
  assert.equal(addDiscussion(state, "one"), true);
  assert.equal(activeMessages(state).length, 0);
  sendPreview(state, "fragment question");
  assert.equal(state.documentMessages[0].text, "main draft");
  assert.match(activeMessages(state)[1].text, /демонстрационный/);
  deleteDiscussion(state, "one");
  assert.equal(state.activeId, "document");
  assert.equal(activeMessages(state)[0].text, "main draft");
  assert.equal(state.threads.length, 0);
});
