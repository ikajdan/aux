// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({
  stdin: {
    contents: `export { snippetInsertion, formattingInsertion } from './src/snippet-insertion.ts'; export { latexSnippets } from './src/latex-snippets.ts'; export { EditorState, EditorSelection } from '@codemirror/state'; export { history, undo, redo } from '@codemirror/commands';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { snippetInsertion, formattingInsertion, latexSnippets, EditorState, EditorSelection, history, undo, redo } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);

test("snippet insertion replaces a selection, separates surrounding text, and is one isolated undo step", () => {
  let state = EditorState.create({ doc: "Before SELECT after", selection: { anchor: 7, head: 13 }, extensions: [history()] });
  const snippet = latexSnippets.find((item) => item.id === "figure").text;
  const dispatch = (transaction) => {
    state = transaction.state ?? state.update(transaction).state;
  };
  dispatch(snippetInsertion(state, snippet));
  assert.equal(state.doc.toString(), `Before \n${snippet}\n after`);
  assert.equal(state.selection.main.empty, true);
  assert.equal(state.selection.main.head, `Before \n${snippet}\n`.length);
  dispatch({ changes: { from: state.selection.main.head, insert: "typed" }, userEvent: "input.type" });
  const target = {
    get state() {
      return state;
    },
    dispatch,
  };
  assert.equal(undo(target), true);
  assert.equal(state.doc.toString(), `Before \n${snippet}\n after`, "undo typing without removing snippet");
  assert.equal(undo(target), true);
  assert.equal(state.doc.toString(), "Before SELECT after");
  assert.equal(state.selection.main.from, 7);
  assert.equal(state.selection.main.to, 13);
  assert.equal(redo(target), true);
  assert.equal(state.doc.toString(), `Before \n${snippet}\n after`);
});

test("insertion handles empty files and line boundaries without adding blank lines", () => {
  const snippet = latexSnippets.find((item) => item.id === "note").text;
  for (const [doc, position, expected] of [
    ["", 0, snippet],
    ["before\n\nafter", 7, `before\n${snippet}\nafter`],
    ["before\n", 7, `before\n${snippet}`],
  ]) {
    const state = EditorState.create({ doc, selection: { anchor: position } });
    assert.equal(state.update(snippetInsertion(state, snippet)).state.doc.toString(), expected);
  }
});

test("read-only state cannot be changed through snippet insertion", () => {
  const state = EditorState.create({ doc: "locked", extensions: [EditorState.readOnly.of(true)] });
  assert.equal(snippetInsertion(state, "replacement"), null);
});

test("multiple cursors insert snippets in the correct positions in one transaction", () => {
  const state = EditorState.create({
    doc: "one\ntwo",
    extensions: [EditorState.allowMultipleSelections.of(true)],
    selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(4)]),
  });
  const next = state.update(snippetInsertion(state, "snippet")).state;
  assert.equal(next.doc.toString(), "snippet\none\nsnippet\ntwo");
  assert.equal(next.selection.ranges.length, 2);
});

test("formatting wraps selections inline, preserves selection direction, and nests without losing text", () => {
  for (const command of ["textbf", "emph", "texttt"]) {
    const state = EditorState.create({ doc: "Before words after", selection: { anchor: 12, head: 7 } });
    const next = state.update(formattingInsertion(state, command)).state;
    assert.equal(next.doc.toString(), `Before \\${command}{words} after`);
    assert.equal(next.sliceDoc(next.selection.main.from, next.selection.main.to), "words");
    assert.ok(next.selection.main.anchor > next.selection.main.head);
    const nested = next.update(formattingInsertion(next, command === "textbf" ? "emph" : "textbf")).state;
    assert.equal(nested.doc.toString(), `Before \\${command}{\\${command === "textbf" ? "emph" : "textbf"}{words}} after`);
  }
});

test("empty formatting puts the cursor inside braces and headings use separate lines", () => {
  for (const command of ["textbf", "emph", "texttt", "section", "subsection", "subsubsection"]) {
    const empty = EditorState.create();
    const next = empty.update(formattingInsertion(empty, command)).state;
    assert.equal(next.doc.toString(), `\\${command}{}`);
    assert.equal(next.selection.main.head, next.doc.length - 1);
    if (command.endsWith("section")) {
      const state = EditorState.create({ doc: "Before title after", selection: { anchor: 7, head: 12 } });
      const heading = state.update(formattingInsertion(state, command)).state;
      assert.equal(heading.doc.toString(), `Before \n\\${command}{title}\n after`);
      assert.equal(heading.sliceDoc(heading.selection.main.from, heading.selection.main.to), "title");
    }
  }
});

test("formatting is read-only safe and multi-selection edits undo atomically", () => {
  const locked = EditorState.create({ extensions: [EditorState.readOnly.of(true)] });
  assert.equal(formattingInsertion(locked, "textbf"), null);
  let state = EditorState.create({
    doc: "one two",
    extensions: [history(), EditorState.allowMultipleSelections.of(true)],
    selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]),
  });
  state = state.update(formattingInsertion(state, "textbf")).state;
  assert.equal(state.doc.toString(), String.raw`\textbf{one} \textbf{two}`);
  const target = {
    get state() {
      return state;
    },
    dispatch(transaction) {
      state = transaction.state;
    },
  };
  assert.equal(undo(target), true);
  assert.equal(state.doc.toString(), "one two");
  assert.equal(state.selection.ranges.length, 2);
  assert.equal(redo(target), true);
  assert.equal(state.doc.toString(), String.raw`\textbf{one} \textbf{two}`);
});

test("formatting shortcuts wrap the current word, respect selections, and handle whitespace", () => {
  for (const command of ["textbf", "emph", "texttt"]) {
    const state = EditorState.create({ doc: "hello world", selection: { anchor: 2 } });
    const next = state.update(formattingInsertion(state, command, true)).state;
    assert.equal(next.doc.toString(), `\\${command}{hello} world`);
    assert.equal(next.sliceDoc(next.selection.main.from, next.selection.main.to), "hello");
    const selected = EditorState.create({ doc: "hello world", selection: { anchor: 1, head: 3 } });
    assert.equal(selected.update(formattingInsertion(selected, command, true)).state.doc.toString(), `h\\${command}{el}lo world`);
    const blank = EditorState.create({ doc: "  ", selection: { anchor: 1 } });
    const inserted = blank.update(formattingInsertion(blank, command, true)).state;
    assert.equal(inserted.doc.toString(), ` \\${command}{} `);
    assert.equal(inserted.selection.main.head, inserted.doc.length - 2);
  }
});

test("display math wraps selections on separate lines and leaves an empty cursor inside delimiters", () => {
  const selected = EditorState.create({ doc: "Before x^2 after", selection: { anchor: 7, head: 10 } });
  const next = selected.update(formattingInsertion(selected, "display-math")).state;
  assert.equal(next.doc.toString(), "Before \n\\[\nx^2\n\\]\n after");
  assert.equal(next.sliceDoc(next.selection.main.from, next.selection.main.to), "x^2");
  const empty = EditorState.create();
  const block = empty.update(formattingInsertion(empty, "display-math")).state;
  assert.equal(block.doc.toString(), "\\[\n\n\\]");
  assert.equal(block.selection.main.head, 3);
  const locked = EditorState.create({ extensions: [EditorState.readOnly.of(true)] });
  assert.equal(formattingInsertion(locked, "display-math"), null);
});

test("list widget inserts a single empty item and positions the cursor after its marker", () => {
  for (const id of ["itemize", "enumerate"]) {
    const snippet = latexSnippets.find((item) => item.id === id);
    assert.equal(snippet.text, `\\begin{${id}}\n    \\item \n\\end{${id}}`);
    for (const doc of ["", "before after"]) {
      const position = doc ? 7 : 0;
      const state = EditorState.create({ doc, selection: { anchor: position } });
      const next = state.update(snippetInsertion(state, snippet.text, snippet.cursorOffset)).state;
      const cursor = next.selection.main.head;
      assert.equal(next.doc.sliceString(cursor - 6, cursor), "\\item ");
      assert.equal(next.doc.sliceString(cursor, cursor + 1), "\n");
      assert.equal(next.selection.main.empty, true);
      const typed = next.update({ changes: { from: cursor, insert: "First item" } }).state;
      assert.ok(typed.doc.toString().includes("\\item First item\n"));
    }
  }
});

test("templates retain real LaTeX commands, table row terminators, and the custom block syntax", () => {
  for (const item of latexSnippets) {
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(item.text), `${item.id}: escaped JS control characters`);
    const stack = [];
    for (const match of item.text.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
      if (match[1] === "begin") stack.push(match[2]);
      else assert.equal(stack.pop(), match[2], `${item.id}: mismatched environment`);
    }
    assert.deepEqual(stack, [], `${item.id}: unclosed environment`);
  }
  for (const kind of ["note", "warning", "important"]) assert.ok(latexSnippets.find((item) => item.id === kind).text.startsWith(`\\begin{block}[${kind}]`));
  for (const kind of ["table", "wide-table"]) {
    const text = latexSnippets.find((item) => item.id === kind).text;
    assert.ok(text.includes(String.raw`\textbf{`));
    assert.ok(text.includes(String.raw`Placeholder \\`) || text.includes(String.raw`Sample text \\`));
  }
});
