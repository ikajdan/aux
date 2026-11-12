// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["src/workspace/editor-draft.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { EditorDraft } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("a new draft starts empty and clean", () => {
  const draft = new EditorDraft();
  assert.equal(draft.text, "");
  assert.equal(draft.savedText, "");
  assert.equal(draft.snapshot(), "");
  assert.equal(draft.dirty, false);
});

test("unsaved updates retain the baseline and undoing to it clears dirty", () => {
  const draft = new EditorDraft();
  draft.load("original");
  draft.update("edited");
  assert.equal(draft.text, "edited");
  assert.equal(draft.savedText, "original");
  assert.equal(draft.dirty, true);
  draft.update("original");
  assert.equal(draft.dirty, false);
});

test("saving a snapshot preserves later edits and keeps them dirty", () => {
  const draft = new EditorDraft();
  draft.load("original");
  draft.update("submitted");
  const snapshot = draft.snapshot();
  draft.update("later edits");
  assert.equal(snapshot, "submitted");
  draft.saved(snapshot);
  assert.equal(draft.text, "later edits");
  assert.equal(draft.savedText, "submitted");
  assert.equal(draft.dirty, true);
});

test("saving the current snapshot clears dirty", () => {
  const draft = new EditorDraft();
  draft.load("original");
  draft.update("saved edit");
  draft.saved(draft.snapshot());
  assert.equal(draft.text, "saved edit");
  assert.equal(draft.savedText, "saved edit");
  assert.equal(draft.dirty, false);
});

test("discard returns the last successfully saved baseline", () => {
  const draft = new EditorDraft();
  draft.load("original");
  draft.update("saved edit");
  draft.saved(draft.snapshot());
  draft.update("unsaved edit");
  assert.equal(draft.discard(), "saved edit");
  assert.equal(draft.text, "saved edit");
  assert.equal(draft.savedText, "saved edit");
  assert.equal(draft.dirty, false);
});

test("load resets the previous document's current text and baseline", () => {
  const draft = new EditorDraft();
  draft.load("first document");
  draft.update("first document edits");
  draft.load("second document");
  assert.equal(draft.text, "second document");
  assert.equal(draft.savedText, "second document");
  assert.equal(draft.snapshot(), "second document");
  assert.equal(draft.dirty, false);
});
