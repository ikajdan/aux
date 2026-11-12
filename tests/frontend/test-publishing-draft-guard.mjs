// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../../src/application.ts", import.meta.url), "utf8");
const start = source.indexOf("async function openPublishing()");
const end = source.indexOf('$("publishing").onclick', start);
assert.ok(start >= 0 && end > start, "publishing opener located");
const makeOpener = new Function(
  "dependencies",
  `
  const { $, resolveEditorDraft, updateTargetBranches, loadTargetBranches,
    pendingMergeRequest, refreshBranchMergeRequest, refreshWarning, updatePageTitle, meta, repo } = dependencies;
  ${source.slice(start, end)}
  return openPublishing;
`,
);

function fixture(resolveEditorDraft) {
  const calls = [];
  const dialog = {
    open: false,
    showModal() {
      calls.push("show");
      this.open = true;
    },
  };
  const elements = { "publishing-dialog": dialog, "mr-result": {}, "mr-title": {} };
  const record = (name) => () => {
    calls.push(name);
  };
  const open = makeOpener({
    $: (id) => {
      assert.ok(id in elements);
      return elements[id];
    },
    resolveEditorDraft,
    updateTargetBranches: record("target"),
    loadTargetBranches: record("branches"),
    pendingMergeRequest: () => undefined,
    refreshBranchMergeRequest: record("mr"),
    refreshWarning: record("changes"),
    updatePageTitle: record("title"),
    meta: {},
    repo: {},
  });
  return { calls, dialog, open };
}

test("Publish Changes waits for the draft decision before opening or fetching metadata", async () => {
  let complete;
  const decision = new Promise((resolve) => {
    complete = resolve;
  });
  const { calls, dialog, open } = fixture((save, discard) => {
    assert.equal(save, "Save and continue");
    assert.equal(discard, "Discard and continue");
    return decision;
  });
  const pending = open();
  assert.equal(dialog.open, false);
  assert.deepEqual(calls, []);
  complete(true);
  await pending;
  assert.equal(dialog.open, true);
  assert.equal(calls[0], "show");
  assert.ok(calls.includes("branches"));
});

test("cancel keeps Publish Changes closed and does not begin remote lookups", async () => {
  const { open, dialog, calls } = fixture(async () => false);
  assert.equal(await open(), false);
  assert.equal(dialog.open, false);
  assert.deepEqual(calls, []);
});

test("save failures keep Publish Changes closed and reach the operation's error handler", async () => {
  const error = new Error("Storage failed");
  const { open, dialog, calls } = fixture(async () => {
    throw error;
  });
  await assert.rejects(open(), (actual) => actual === error);
  assert.equal(dialog.open, false);
  assert.deepEqual(calls, []);
});

test("an already-open publishing dialog does not prompt again", async () => {
  const { open, dialog, calls } = fixture(() => assert.fail("must not ask again"));
  dialog.open = true;
  await open();
  assert.deepEqual(calls, []);
});
