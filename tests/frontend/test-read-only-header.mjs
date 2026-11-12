// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { transform } from "esbuild";

const source = await readFile("src/application.ts", "utf8");

test("the header reflects actual editability without mistaking busy operations for read-only files", async () => {
  const fn = source.match(/function updateFilenameSaveState\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fn);
  const { code } = await transform(fn, { loader: "ts" });
  const actions = { hidden: true };
  const elements = {
    filename: { classList: { toggle() {} } },
    "file-read-only": { hidden: true },
    "discard-file": { closest: () => actions },
  };
  const context = vm.createContext({
    $: (id) => elements[id],
    repo: { dir: "/workspace" },
    meta: { dir: "/workspace" },
    file: null,
    editable: false,
    editor: { canEdit: () => context.editable },
    editorDraft: { dirty: false },
    pendingFileSaves: new Map(),
    workspaceWarnings: new Map(),
    hasUnsavedDocument: () => false,
    busy: false,
  });
  vm.runInContext(code, context);
  for (const [path, editable, busy, expectedHidden] of [
    [null, false, false, true],
    ["template/layout.tex", false, false, false],
    [".latexmkrc", false, false, false],
    ["image.png", false, false, false],
    ["document.pdf", false, false, false],
    ["main.tex", true, false, true],
    ["main.tex", true, true, true],
    [null, false, true, true],
  ]) {
    context.file = path;
    context.editable = editable;
    context.busy = busy;
    context.updateFilenameSaveState();
    assert.equal(elements["file-read-only"].hidden, expectedHidden, `${path}: editable=${editable}, busy=${busy}`);
  }
});
