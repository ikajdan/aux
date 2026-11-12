// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";

export function listContinuation(state: EditorState): TransactionSpec | null {
  if (state.readOnly || state.selection.ranges.length !== 1) return null;
  const cursor = state.selection.main;
  if (!cursor.empty) return null;
  const line = state.doc.lineAt(cursor.head);
  if (cursor.head !== line.to) return null;
  const item = /^([\t ]*)\\item(?:\[[^\]\r\n]*\][\t ]*(.*)|(?:[\t ]+(.*))?)$/.exec(line.text);
  if (!item) return null;
  const indent = item[1];
  const content = item[2] ?? item[3] ?? "";
  if (!content.trim()) {
    return {
      changes: { from: line.from + indent.length, to: line.to, insert: "" },
      selection: EditorSelection.cursor(line.from + indent.length),
      userEvent: "input",
      annotations: isolateHistory.of("full"),
      scrollIntoView: true,
    };
  }
  const insert = `\n${indent}\\item `;
  return {
    changes: { from: cursor.head, insert },
    selection: EditorSelection.cursor(cursor.head + insert.length),
    userEvent: "input",
    annotations: isolateHistory.of("full"),
    scrollIntoView: true,
  };
}
