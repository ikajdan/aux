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
const { code } = await transform(`globalThis.editor = { ${method} };`, { loader: "ts" });
const bundle = await build({ entryPoints: ["src/workspace/editor-document.ts"], bundle: true, write: false, format: "esm" });
const { createEditorDocument } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

function fixture(text, { readOnly = false, hidden = false, write = async () => {}, flush = async () => {} } = {}) {
  let documents;
  let savedText = text;
  const draft = {
    update: value => documents.updateEditorDraft(value),
    get text() { return view.state.doc.toString(); },
    get savedText() { return savedText; },
    get dirty() { return documents.dirty; },
  };
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
  const context = vm.createContext({ view, currentPath: "main.tex", readOnly, parent: { hidden } });
  vm.runInContext(code, context);
  context.editor.canEdit = () => !readOnly && !hidden;
  context.editor.setText = () => {};
  const discard = { closest: () => ({}) };
  documents = createEditorDocument({
    editor: context.editor,
    imagePreview: {},
    fs: { promises: { flush: async () => { await flush(); savedText = writes.at(-1)?.text ?? savedText; } } },
    getWorkspace: () => ({ repo, meta: { project: 1, dir: "/workspace" } }),
    workspaceWarnings: new Map([["/workspace", warning]]),
    warningState: () => warning,
    elements: { filename: { classList: { toggle() {} } }, readOnly: {}, discard },
    isBusy: () => false,
    showWorkspaceStatus() {}, updatePublishingSummary() {}, syncTree() {},
    markWorkspace() {}, refresh: async () => {}, refreshSearch() {},
  });
  documents.path = "main.tex";
  documents.loadEditorDocument(text, "main.tex");
  context.saveDocument = documents.saveDocument;

  return { context, view, draft, writes, warning, documents };
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
  await f.documents.saving;
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
  await f.documents.saving;
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
