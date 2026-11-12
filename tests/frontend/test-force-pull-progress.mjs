// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { transform } from "esbuild";

const source = await readFile("src/application.ts", "utf8");
const start = source.indexOf("async function pull(");
const end = source.indexOf("async function openFile(", start);
assert.ok(start >= 0 && end > start);
const { code } = await transform(source.slice(start, end), { loader: "ts" });

function fixture(confirm) {
  const statuses = [];
  const requests = [];
  const stop = new Error("Stop after branch lookup");
  const context = vm.createContext({
    resolveEditorDraft: async () => true,
    $: () => ({ value: "main" }),
    project: { id: 1, path_with_namespace: "team/document" },
    meta: null,
    workspaces: {},
    confirmDialog: confirm,
    status: (message, state) => statuses.push({ message, state }),
    api: {
      request: async (endpoint) => {
        requests.push(endpoint);
        throw stop;
      },
    },
  });
  vm.runInContext(code, context);
  return { context, statuses, requests, stop };
}

test("force pull starts its progress toast only after confirmation", async () => {
  let answer;
  const confirmation = new Promise((resolve) => {
    answer = resolve;
  });
  const f = fixture(() => confirmation);
  const pulling = f.context.pull(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.statuses, []);
  assert.deepEqual(f.requests, []);
  answer(true);
  await assert.rejects(pulling, (error) => error === f.stop);
  assert.deepEqual(f.statuses, [{ message: "Updating local files…", state: "busy" }]);
  assert.equal(f.requests.length, 1);
});

test("canceling force pull shows no progress toast and makes no request", async () => {
  const f = fixture(async () => false);
  assert.equal(await f.context.pull(true), false);
  assert.deepEqual(f.statuses, []);
  assert.deepEqual(f.requests, []);
});

function replacementFixture(failure) {
  const f = fixture(async () => true);
  const previous = { dir: "/old", branch: "main", base: "local-work" };
  const other = { dir: "/other", branch: "feature" };
  const workspaces = { "1:main": previous, "1:feature": other };
  const activated = [];
  const persisted = [];
  const error = new Error(`Injected ${failure} failure`);
  Object.assign(f.context, {
    workspaces,
    meta: previous,
    fs: {},
    serverConfig: { limits: {} },
    api: { request: async () => ({ commit: { id: "remote-head" } }) },
    fetchSnapshot: async () => ({ files: [{ path: "main.tex", bytes: new Uint8Array([1]) }], links: [] }),
    createFileOperationProgress: () => () => {},
    randomId: () => "replacement",
    Repository: class {
      async init() {}
      async write() {
        if (failure === "write") throw error;
      }
      async commit() {
        if (failure === "commit") throw error;
        return "import-base";
      }
    },
    persist: (next) => {
      if (failure === "persist") throw error;
      persisted.push(next);
    },
    showWorkspaceStatus: () => {},
    activate: async (workspace) => {
      activated.push(workspace);
      return true;
    },
  });
  return { ...f, workspaces, previous, other, activated, persisted, error };
}

for (const failure of ["write", "commit", "persist"]) {
  test(`force pull preserves cached workspaces when ${failure} fails`, async () => {
    const f = replacementFixture(failure);
    await assert.rejects(f.context.pull(true, { build: false }), (error) => error === f.error);
    assert.equal(f.context.workspaces, f.workspaces);
    assert.equal(f.context.workspaces["1:main"], f.previous);
    assert.equal(f.context.workspaces["1:feature"], f.other);
    assert.equal(f.context.meta, f.previous);
    assert.deepEqual(f.activated, []);
    assert.deepEqual(f.persisted, []);
  });
}

test("successful force pull persists and activates only the replacement branch", async () => {
  const f = replacementFixture();
  assert.equal(await f.context.pull(true, { build: false }), true);
  const replacement = f.context.workspaces["1:main"];
  assert.notEqual(replacement, f.previous);
  assert.equal(replacement.base, "import-base");
  assert.equal(replacement.remote, "remote-head");
  assert.equal(f.context.workspaces["1:feature"], f.other);
  assert.equal(f.persisted[0], f.context.workspaces);
  assert.deepEqual(f.activated, [replacement]);
});
