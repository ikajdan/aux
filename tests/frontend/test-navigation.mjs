// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({ entryPoints: ["src/workspace/navigation.ts"], bundle: true, write: false, platform: "node", format: "esm" });
const { createNavigationController, validDocument, validNavigation } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ initial, saved, missing = false } = {}) {
  const calls = [];
  const project = { id: 7, path_with_namespace: "group/project" };
  const meta = { project: 7, branch: "main", dir: "/cached" };
  const context = { busy: false, project, meta, file: "main.tex", workspaceReady: true, repo: { files: async () => ["main.tex", "other.tex"] } };
  let visible = true, listener, controller;
  const values = new Map(saved ? [["aux-active-document", JSON.stringify(saved)]] : []);
  const history = {
    state: { unrelated: 42, ...(initial ? { auxView: initial } : {}) },
    replaceState(state) { this.state = state; calls.push(["replace", state.auxView]); },
    pushState(state) { this.state = state; calls.push(["push", state.auxView]); },
    go(delta) { calls.push(["go", delta]); },
    back() { calls.push(["back"]); },
  };
  const deps = {
    history, storage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    events: { addEventListener: (_, fn) => { listener = fn; } },
    randomId: () => "session", getContext: () => context, getWorkspaces: () => ({ cached: meta }), getCatalog: () => [project],
    setProject: (value) => { context.project = value; }, clearTreeProject: () => calls.push(["clearTree"]),
    setSidebarBranches: (branches) => calls.push(["branches", branches]), selectFilesTab: () => calls.push(["filesTab"]),
    isEditorVisible: () => visible,
    showView(editor, options) { visible = editor; controller.recordNavigation(editor); controller.persistActiveDocument(editor); calls.push(["view", editor, options]); },
    activate: async (workspace, options) => { calls.push(["activate", workspace, options, controller.restoring]); controller.persistActiveDocument(); return true; },
    openFile: async (path) => { context.file = path; calls.push(["open", path]); },
    confirmWorkspaceLeave: async () => true, run: async (action) => action(),
    stat: async (path) => { calls.push(["stat", path]); if (missing) throw Error("missing"); },
  };
  controller = createNavigationController(deps);
  return { controller, deps, context, calls, values, history, pop(next) { history.state = { ...history.state, auxView: next }; listener({ state: history.state }); } };
}

test("validators retain existing history/document acceptance", () => {
  assert.equal(validNavigation({ session: "s", index: 0, view: "documents" }), true);
  for (const index of [-1, 0.5, Infinity]) assert.equal(validNavigation({ session: "s", index, view: "editor" }), false);
  assert.equal(validDocument({ projectId: 0, branch: "main", filePath: null }), true);
  assert.equal(validDocument({ projectId: "", branch: "main" }), false);
});

test("construction initializes history without reading live dependencies", () => {
  const f = fixture();
  assert.equal(f.calls.length, 1);
  assert.equal(f.history.state.unrelated, 42);
  assert.deepEqual(f.history.state.auxView, { session: "session", index: 0, view: "documents" });
  f.controller.recordNavigation(true);
  f.context.file = "other.tex";
  f.controller.persistActiveDocument();
  assert.equal(f.calls.filter(([kind]) => kind === "push").length, 1);
  assert.equal(f.history.state.auxView.filePath, "other.tex");
  f.controller.goDocuments();
  assert.deepEqual(f.calls.at(-1), ["back"]);
});

test("busy popstate is deferred and cancellation compensates history", async () => {
  const f = fixture();
  f.controller.recordNavigation(true);
  f.context.busy = true;
  f.pop({ session: "session", index: 0, view: "documents" });
  f.controller.recordNavigation(false);
  assert.equal(f.calls.filter(([kind]) => kind === "view").length, 0);
  f.deps.confirmWorkspaceLeave = async () => false;
  f.context.busy = false;
  await f.controller.processNavigation();
  assert.deepEqual(f.calls.at(-1), ["go", 1]);
});

test("foreign sessions are ignored and missing cached targets become documents", async () => {
  const f = fixture();
  f.pop({ session: "foreign", index: 1, view: "editor" });
  await tick();
  assert.equal(f.calls.length, 1);
  f.pop({ session: "session", index: 1, view: "editor", project: { id: 99 }, branch: "main", dir: "/missing" });
  await tick();
  assert.equal(f.history.state.auxView.view, "documents");
  assert.equal(f.values.has("aux-active-document"), false);
});

test("startup restores saved file with persistence suppressed during activation", async () => {
  const f = fixture({ saved: { projectId: "7", branch: "main", filePath: "other.tex" } });
  assert.equal(await f.controller.restoreActiveDocument(), true);
  assert.equal(f.calls.find(([kind]) => kind === "activate")[3], true);
  assert.deepEqual(f.calls.find(([kind]) => kind === "open"), ["open", "other.tex"]);
  assert.equal(f.controller.restoring, false);
  assert.equal(JSON.parse(f.values.get("aux-active-document")).filePath, "other.tex");
});

test("documents history suppresses saved startup and missing repositories are not activated", async () => {
  const saved = { projectId: 7, branch: "main", filePath: "other.tex" };
  for (const options of [{ initial: { session: "s", index: 0, view: "documents" }, saved }, { saved, missing: true }]) {
    const f = fixture(options);
    await f.controller.restoreActiveDocument();
    assert.equal(f.calls.some(([kind]) => kind === "activate"), false);
    assert.deepEqual(f.calls.find(([kind]) => kind === "view"), ["view", false, { focus: false }]);
  }
});
