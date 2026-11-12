// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { build, transform } from "esbuild";

const source = await readFile("src/application.ts", "utf8");
const from = source.indexOf("async function push(");
const to = source.indexOf("const outputTabs =", from);
assert.ok(from >= 0 && to > from, "Extract the actual application push function");
const { code } = await transform(source.slice(from, to), { loader: "ts" });
const bundled = await build({ entryPoints: ["src/gitlab-merge-request.ts"], bundle: true, write: false, format: "esm", platform: "browser" });
const { publishMergeRequestBranch } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);

const root = "projects/1/repository";
const target = "feature/published";
const targetPath = `${root}/branches/feature%2Fpublished`;
const sourcePath = `${root}/branches/feature%2Fsource`;
const filePath = `${root}/files/sections%2Fintro.tex?ref=baseline`;
const author = { name: "Test Author", email: "test@example.invalid" };
const message = "Publish introduction";
const action = { action: "update", file_path: "sections/intro.tex", content: "bmV3", encoding: "base64" };
const missing = { endpoint: targetPath, error: Object.assign(new Error("Branch not found"), { status: 404 }) };
const sourceRead = { endpoint: sourcePath, result: { commit: { id: "baseline" } } };
const reservation = { endpoint: `${root}/branches`, body: { branch: target, ref: "baseline" }, result: { commit: { id: "baseline" } } };
// The file's source-branch guard is deliberately neither the baseline nor a default-branch guard.
const fileRead = { endpoint: filePath, result: { last_commit_id: "source-file-last-commit" } };
const targetRead = { endpoint: targetPath, result: { commit: { id: "baseline" } } };
const commit = {
  endpoint: `${root}/commits`,
  body: {
    branch: target,
    commit_message: message,
    author_name: author.name,
    author_email: author.email,
    actions: [{ ...action, last_commit_id: "source-file-last-commit" }],
  },
  result: { id: "remotecommit" },
};
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture(t, steps) {
  const requests = [];
  const failures = [];
  const persisted = [];
  const events = [];
  const initialMeta = { project: 1, dir: "/workspace", branch: "feature/source", base: "localbase", remote: "baseline", modes: {} };
  const initialWorkspaces = { "1:feature/source": initialMeta };
  const elements = {
    target: { value: target },
    message: { value: message },
    author: { value: author.name },
    email: { value: author.email },
  };
  const context = vm.createContext({
    $: (id) => {
      assert.ok(Object.hasOwn(elements, id), `Unexpected element: ${id}`);
      return elements[id];
    },
    meta: initialMeta,
    project: { id: 1 },
    workspaces: initialWorkspaces,
    resolveEditorDraft: async () => true,
    repo: {
      changes: async () => [],
      head: async () => "localhead",
      snapshot: async (ref) => {
        assert.ok(ref === "localbase" || ref === "localhead");
        return { "sections/intro.tex": { content: ref === "localbase" ? "old" : "new", mode: "100644" } };
      },
      history: async () => [{ commit: { message: "Fallback commit message" } }],
    },
    changedActions: (base, current) => {
      assert.equal(base["sections/intro.tex"].content, "old");
      assert.equal(current["sections/intro.tex"].content, "new");
      return [{ ...action }];
    },
    publishMergeRequestBranch,
    api: {
      request: async (endpoint, body) => {
        const step = steps[requests.length];
        requests.push({ method: body === undefined ? "GET" : "POST", endpoint, ...(body === undefined ? {} : { body: plain(body) }) });
        try {
          assert.ok(step, `Unexpected request: ${JSON.stringify(requests.at(-1))}`);
          assert.equal(endpoint, step.endpoint);
          assert.equal(body !== undefined, Object.hasOwn(step, "body"), "Request method/body presence");
          if (body !== undefined) assert.deepEqual(plain(body), step.body);
          if (endpoint === `${root}/commits`) assert.equal(Object.hasOwn(body, "start_sha"), false, "Never implicitly create a branch via start_sha");
        } catch (error) {
          // Production catches some API errors; retain assertion failures so those cannot mask a bad request.
          failures.push(error);
          throw error;
        }
        if (step.error) throw step.error;
        return structuredClone(step.result);
      },
    },
    persist: (next) => {
      persisted.push(plain(next));
      events.push("persist");
    },
    confirmDialog: async () => {
      events.push("confirm");
      return false;
    },
    status: (message, state) => events.push({ message, state }),
  });
  vm.runInContext(code, context);
  t.after(() => {
    assert.deepEqual(failures, [], "All API requests must match, even when production catches an error");
    assert.equal(requests.length, steps.length, "All expected requests completed");
  });
  return { context, initialMeta, initialWorkspaces, requests, persisted, events };
}

function assertSourceUnchanged(f) {
  assert.equal(f.context.meta.branch, "feature/source");
  assert.equal(f.context.meta.base, "localbase");
  assert.equal(f.context.meta.remote, "baseline");
  assert.deepEqual(f.initialMeta, { project: 1, dir: "/workspace", branch: "feature/source", base: "localbase", remote: "baseline", modes: {} });
}

function assertNoPublication(f) {
  assertSourceUnchanged(f);
  assert.equal(f.context.meta, f.initialMeta);
  assert.equal(f.context.workspaces, f.initialWorkspaces);
  assert.deepEqual(f.persisted, []);
  assert.equal(f.events.includes("confirm"), false);
  assert.equal(f.requests.some((request) => request.endpoint === `${root}/commits`), false);
}

function assertReceipt(f) {
  assertSourceUnchanged(f);
  assert.equal(f.persisted.length, 1);
  const saved = f.persisted[0]["1:feature/source"];
  assert.deepEqual(saved.publication, { localHead: "localhead", branch: target, remoteCommit: "remotecommit" });
  assert.equal(saved.base, "localbase");
  assert.equal(saved.remote, "baseline");
  assert.deepEqual(plain(f.context.meta), saved);
  assert.deepEqual(plain(f.context.workspaces), f.persisted[0]);
  assert.ok(f.events.indexOf("persist") < f.events.indexOf("confirm"), "Persist the receipt before offering to switch");
}

test("push to a missing branch reserves the pulled source baseline and publishes with the source file guard", async (t) => {
  const f = fixture(t, [missing, sourceRead, reservation, fileRead, targetRead, commit]);
  const result = await f.context.push();
  assert.equal(result.statusHandled, true);
  assertReceipt(f);
  assert.deepEqual(f.requests.map((request) => request.method), ["GET", "GET", "POST", "GET", "GET", "POST"]);
  assert.match(f.events.at(-1).message, /still editing feature\/source/);
});

test("a new-branch reservation collision sends no commit and retains the source workspace", async (t) => {
  const f = fixture(t, [missing, sourceRead, { ...reservation, error: new Error("Branch already exists") }]);
  await assert.rejects(f.context.push(), /Could not reserve new branch.*No commit was sent.*Branch already exists/);
  assertNoPublication(f);
});

test("a reserved target that moved before publication sends no commit", async (t) => {
  const f = fixture(t, [missing, sourceRead, reservation, fileRead, { ...targetRead, result: { commit: { id: "other-author-commit" } } }]);
  await assert.rejects(f.context.push(), /Local work is retained.*New branch changed before publication.*No commit sent/);
  assertNoPublication(f);
});

test("a source branch that moved from the pulled baseline prevents branch creation and publication", async (t) => {
  const f = fixture(t, [missing, { ...sourceRead, result: { commit: { id: "new-source-head" } } }]);
  await assert.rejects(f.context.push(), /Current branch has changed.*Pull\/reconcile/);
  assertNoPublication(f);
  assert.equal(f.requests.some((request) => request.method === "POST"), false);
});

test("push to an existing target preserves last_commit_id guards without reserving a branch", async (t) => {
  const f = fixture(t, [targetRead, fileRead, commit]);
  const result = await f.context.push();
  assert.equal(result.statusHandled, true);
  assertReceipt(f);
  assert.equal(f.requests.some((request) => request.endpoint === `${root}/branches`), false);
  assert.equal(f.requests.some((request) => request.endpoint === sourcePath), false);
});
