// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["src/workspace/editor-document.ts"], bundle: true, write: false, format: "esm" });
const { createEditorDocument } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("the header reflects actual editability without mistaking busy operations for read-only files", async () => {
  const actions = { hidden: true };
  const elements = {
    filename: { classList: { toggle() {} } },
    "file-read-only": { hidden: true },
    "discard-file": { closest: () => actions },
  };
  const context = { editable: false, busy: false };
  const documents = createEditorDocument({
    getWorkspace: () => ({ repo: { dir: "/workspace" }, meta: { dir: "/workspace" } }),
    editor: { canEdit: () => context.editable },
    elements: { filename: elements.filename, readOnly: elements["file-read-only"], discard: elements["discard-file"] },
    workspaceWarnings: new Map([["/workspace", { errors: new Set(["main.tex", "template/layout.tex"]) }]]),
    isBusy: () => context.busy,
  });
  for (const [path, editable, busy, expectedHidden] of [
    [null, false, false, true],
    ["template/layout.tex", false, false, false],
    ["template/layout.tex", false, true, false],
    ["main.tex", true, false, true],
    ["main.tex", true, true, true],
    [null, false, true, true],
  ]) {
    documents.path = path;
    context.editable = editable;
    context.busy = busy;
    documents.updateFilenameSaveState();
    const message = `${path}: editable=${editable}, busy=${busy}`;
    assert.equal(elements["file-read-only"].hidden, expectedHidden, message);
    assert.equal(actions.hidden, !editable, message);
    assert.equal(elements["discard-file"].disabled, busy || !path, message);
  }
});
