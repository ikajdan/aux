// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { build, transform } from "esbuild";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";

const editorSource = await readFile("src/latex-editor.ts", "utf8");
const method = editorSource.match(/    ensureFinalNewline\(\) \{[\s\S]*?\n    \},/)?.[0];
assert.ok(method);
const source = await readFile("src/application.ts", "utf8");
const start = source.indexOf("async function saveDocument()");
const end = source.indexOf("async function discardDocument(", start);
assert.ok(start >= 0 && end > start);
const { code } = await transform(`globalThis.editor = { ${method} };\n${source.slice(start, end)}`, { loader: "ts" });
const bundle = await build({ entryPoints: ["src/workspace/editor-draft.ts"], bundle: true, write: false, format: "esm" });
const { EditorDraft } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

function fixture(text, { readOnly = false, hidden = false, write = async () => {}, flush = async () => {} } = {}) {
  const draft = new EditorDraft();
  draft.load(text);
  const view = {
    state: EditorState.create({ doc: text, selection: { anchor: Math.min(2, text.length) }, extensions: [history()] }),
    dispatch(spec) {
      this.state = this.state.update(spec).state;
      draft.update(this.state.doc.toString());
    },
  };
  const writes = [];
  const warning = { pending: 0, errors: new Set(), draft: false };
  const repo = {
    dir: "/workspace",
    write: async (path, bytes) => { writes.push({ path, text: new TextDecoder().decode(bytes) }); await write(); },
  };
  const context = vm.createContext({
    view, currentPath: "main.tex", readOnly, parent: { hidden },
    repo, file: "main.tex", meta: { project: 1, dir: "/workspace" },
    editorDraft: draft,
    documentGeneration: 1,
    pendingFileSaves: new Map(),
    saving: Promise.resolve(),
    TextEncoder,
    hasUnsavedDocument: () => draft.dirty,
    warningState: () => warning,
    updateFilenameSaveState() {},
    markWorkspace() {},
    showWorkspaceStatus() {},
    fs: { promises: { flush } },
    refresh: async () => {},
    workspaceSearch: { refresh() {} },
  });
  vm.runInContext(code, context);
  context.editor.canEdit = () => !readOnly && !hidden;
  return { context, view, draft, writes, warning };
}

for (const [input, expected] of [["hello", "hello\n"], ["hello\n", "hello\n"], ["hello\n\n", "hello\n\n"], ["", ""]]) {
  test(`save normalizes the final newline for ${JSON.stringify(input)}`, async () => {
    const f = fixture(input);
    await f.context.saveDocument();
    assert.equal(f.view.state.doc.toString(), expected);
    assert.equal(f.draft.savedText, expected);
    assert.equal(f.draft.dirty, false);
    assert.deepEqual(f.writes, input === expected ? [] : [{ path: "main.tex", text: expected }]);
  });
}

test("normalization keeps the selection and is undoable without replacing editor state", () => {
  const f = fixture("text without newline");
  const selection = f.view.state.selection.toJSON();
  f.context.editor.ensureFinalNewline();
  assert.deepEqual(f.view.state.selection.toJSON(), selection);
  assert.equal(undo({ state: f.view.state, dispatch: transaction => { f.view.state = transaction.state; } }), true);
  assert.equal(f.view.state.doc.toString(), "text without newline");
});

test("read-only files and hidden binary/image previews are never normalized or written", async () => {
  for (const options of [{ readOnly: true }, { hidden: true }]) {
    const f = fixture("unchanged", options);
    f.context.editor.ensureFinalNewline();
    assert.equal(await f.context.saveDocument(), false);
    assert.equal(f.view.state.doc.toString(), "unchanged");
    assert.deepEqual(f.writes, []);
  }
});

test("failed saves retain the normalized draft as unsaved", async () => {
  const failure = new Error("Storage failed");
  const f = fixture("text", { flush: async () => { throw failure; } });
  await assert.rejects(f.context.saveDocument(), error => error === failure);
  assert.equal(f.draft.text, "text\n");
  assert.equal(f.draft.savedText, "text");
  assert.equal(f.draft.dirty, true);
  assert.equal(f.warning.errors.has("main.tex"), true);
});

test("retrying a failed save succeeds and clears its error and pending state", async () => {
  let attempts = 0;
  const failure = new Error("Storage failed");
  const f = fixture("text", {
    flush: async () => {
      if (++attempts === 1) throw failure;
    },
  });
  await assert.rejects(f.context.saveDocument(), (error) => error === failure);
  assert.equal(f.warning.errors.has("main.tex"), true);
  assert.equal(f.warning.pending, 0);
  assert.equal(f.context.pendingFileSaves.size, 0);
  assert.equal(await f.context.saveDocument(), true);
  assert.equal(attempts, 2);
  assert.deepEqual(f.writes, [
    { path: "main.tex", text: "text\n" },
    { path: "main.tex", text: "text\n" },
  ]);
  assert.equal(f.draft.savedText, "text\n");
  assert.equal(f.draft.dirty, false);
  assert.equal(f.warning.errors.has("main.tex"), false);
  assert.equal(f.warning.pending, 0);
  assert.equal(f.context.pendingFileSaves.size, 0);
});

test("saving a normalized snapshot does not overwrite edits made while the write is pending", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture("text", { write: () => gate });
  const saving = f.context.saveDocument();
  await new Promise(resolve => setImmediate(resolve));
  f.view.dispatch({ changes: { from: 0, to: f.view.state.doc.length, insert: "later edit" } });
  release();
  await saving;
  assert.equal(f.draft.savedText, "text\n");
  assert.equal(f.draft.text, "later edit");
  assert.equal(f.draft.dirty, true);
});
