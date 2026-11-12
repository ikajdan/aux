// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";

export type FormattingCommand = "textbf" | "emph" | "texttt" | "section" | "subsection" | "subsubsection" | "display-math";

export function formattingInsertion(state: EditorState, command: FormattingCommand, wordAtCursor = false): TransactionSpec | null {
  if (state.readOnly) return null;
  const math = command === "display-math";
  const block = math || command === "section" || command === "subsection" || command === "subsubsection";
  return {
    ...state.changeByRange((selection) => {
      const range = wordAtCursor && selection.empty ? (state.wordAt(selection.head) ?? selection) : selection;
      const before = block && range.from > state.doc.lineAt(range.from).from ? "\n" : "";
      const after = block && range.to < state.doc.lineAt(range.to).to ? "\n" : "";
      const prefix = before + (math ? "\\[\n" : `\\${command}{`);
      const suffix = math ? "\n\\]" : "}";
      const selected = state.sliceDoc(range.from, range.to);
      return {
        changes: { from: range.from, to: range.to, insert: prefix + selected + suffix + after },
        range: EditorSelection.range(range.anchor + prefix.length, range.head + prefix.length),
      };
    }),
    scrollIntoView: true,
    userEvent: "input",
    annotations: isolateHistory.of("full"),
  };
}

export function snippetInsertion(state: EditorState, text: string, cursorOffset?: number): TransactionSpec | null {
  if (state.readOnly || !text) return null;
  return {
    ...state.changeByRange((range) => {
      const before = range.from > state.doc.lineAt(range.from).from ? "\n" : "";
      const after = range.to < state.doc.lineAt(range.to).to ? "\n" : "";
      const insert = before + text + after;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + (cursorOffset === undefined ? insert.length : before.length + cursorOffset)),
      };
    }),
    scrollIntoView: true,
    userEvent: "input",
    // Keep a whole snippet separate from typing on either side in undo history.
    annotations: isolateHistory.of("full"),
  };
}
