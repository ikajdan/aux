// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: `export { listContinuation } from './src/latex-list-editing.ts'; export { EditorState, EditorSelection } from '@codemirror/state'; export { history, undo, redo } from '@codemirror/commands';`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, format: "esm", platform: "node",
});
const { listContinuation, EditorState, EditorSelection, history, undo, redo } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const atEnd = (doc, extensions = []) => EditorState.create({ doc, selection: { anchor: doc.length }, extensions });

test("Enter continues indented list items without copying optional labels", () => {
  for (const [line, expected] of [
    [String.raw`\item First`, String.raw`\item `],
    [String.raw`    \item Nested`, String.raw`    \item `],
    ["\t\\item[Custom label] First", "\t\\item "],
    [String.raw`\item[Label]Text`, String.raw`\item `],
  ]) {
    const next = atEnd(line).update(listContinuation(atEnd(line))).state;
    assert.equal(next.doc.toString(), `${line}\n${expected}`);
    assert.equal(next.selection.main.head, next.doc.length);
  }
});

test("Enter on an empty item removes its marker but preserves indentation and environment boundaries", () => {
  for (const marker of ["\\item", "\\item   ", "\\item[Label] "]) {
    const doc = `\\begin{itemize}\n    ${marker}\n\\end{itemize}`;
    const position = doc.indexOf("\n\\end");
    const state = EditorState.create({ doc, selection: { anchor: position } });
    const next = state.update(listContinuation(state)).state;
    assert.equal(next.doc.toString(), "\\begin{itemize}\n    \n\\end{itemize}");
    assert.equal(next.selection.main.head, "\\begin{itemize}\n    ".length);
    assert.equal(listContinuation(next), null, "a second Enter must use normal editor handling");
  }
});

test("normal Enter is retained outside an item end, with selections, multiple cursors, and read-only files", () => {
  for (const text of ["ordinary text", "% \\item Comment", "\\itemize", "\\item*", "\\item[unfinished", "prefix \\item Text"])
    assert.equal(listContinuation(atEnd(text)), null, text);
  assert.equal(listContinuation(EditorState.create({ doc: "\\item Text", selection: { anchor: 7 } })), null);
  assert.equal(listContinuation(EditorState.create({ doc: "\\item Text", selection: { anchor: 6, head: 10 } })), null);
  assert.equal(listContinuation(atEnd("\\item Text", [EditorState.readOnly.of(true)])), null);
  const multiple = EditorState.create({
    doc: "\\item One\n\\item Two", extensions: [EditorState.allowMultipleSelections.of(true)],
    selection: EditorSelection.create([EditorSelection.cursor(9), EditorSelection.cursor(19)]),
  });
  assert.equal(listContinuation(multiple), null);
});

test("continuing and exiting items each undo and redo atomically", () => {
  for (const original of ["  \\item First", "  \\item "]) {
    let state = atEnd(original, [history()]);
    state = state.update(listContinuation(state)).state;
    const edited = state.doc.toString();
    const target = { get state() { return state; }, dispatch(transaction) { state = transaction.state; } };
    assert.equal(undo(target), true);
    assert.equal(state.doc.toString(), original);
    assert.equal(state.selection.main.head, original.length);
    assert.equal(redo(target), true);
    assert.equal(state.doc.toString(), edited);
  }
});
