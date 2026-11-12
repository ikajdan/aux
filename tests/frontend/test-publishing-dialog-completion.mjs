// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { transform } from "esbuild";

const source = await readFile("src/application.ts", "utf8");
const start = source.indexOf("async function publishMergeRequest()");
const end = source.indexOf("async function push(", start);
assert.ok(start >= 0 && end > start);
const { code } = await transform(source.slice(start, end), { loader: "ts" });

function fixture({ create = async () => ({ iid: 1, web_url: "https://gitlab.example/merge_requests/1" }), completion = async () => true } = {}) {
  const dialog = {
    open: true,
    closes: 0,
    close() {
      this.open = false;
      this.closes++;
    },
  };
  const pending = { source: "feature", target: "main", title: "Test change", commit: "remote-commit" };
  const context = vm.createContext({
    meta: { dir: "/workspace", branch: "feature" },
    project: { id: 1 },
    api: {},
    getProjectDefaultBranch: async () => "main",
    updateMergeRequestControls() {},
    resolveEditorDraft: async () => true,
    pendingMergeRequest: () => pending,
    pendingMergeRequests: new Map(),
    $: (id) => {
      if (id === "mr-title") return { value: "" };
      assert.equal(id, "publishing-dialog");
      return dialog;
    },
    localStorage: { setItem() {}, removeItem() {} },
    createMergeRequest: create,
    recordPublishingSuccess() {},
    showPublishedBranch: completion,
  });
  vm.runInContext(code, context);
  return { dialog, publish: () => context.publishMergeRequest() };
}

test("Publish Changes closes only after the successful MR information dialog is dismissed", async () => {
  let dismiss;
  const finalDialog = new Promise((resolve) => {
    dismiss = resolve;
  });
  let showing = false;
  const f = fixture({
    completion: () => {
      showing = true;
      return finalDialog;
    },
  });
  const publishing = f.publish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(showing, true);
  assert.equal(f.dialog.open, true);
  assert.equal(f.dialog.closes, 0);
  dismiss(true);
  const result = await publishing;
  assert.equal(result.statusHandled, true);
  assert.equal(f.dialog.open, false);
  assert.equal(f.dialog.closes, 1);
});

test("MR creation failure keeps Publish Changes open for retry", async () => {
  const f = fixture({
    create: async () => {
      throw new Error("GitLab unavailable");
    },
  });
  await assert.rejects(f.publish(), /merge request creation failed/);
  assert.equal(f.dialog.open, true);
  assert.equal(f.dialog.closes, 0);
});

test("publication follow-up errors keep Publish Changes open", async () => {
  const f = fixture({ completion: async () => false });
  await f.publish();
  assert.equal(f.dialog.open, true);
  assert.equal(f.dialog.closes, 0);
});
