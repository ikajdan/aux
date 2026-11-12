// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const buildSource = await readFile("scripts/build.mjs", "utf8");
const viewerCSS = await readFile("node_modules/pdfjs-dist/web/pdf_viewer.css", "utf8");
const start = buildSource.indexOf("const viewerCSS =");
const end = buildSource.indexOf("const { version }", start);
assert.ok(start >= 0 && end > start);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const generate = new AsyncFunction("readFile", "writeFile", buildSource.slice(start, end));

async function generatedStyles(source = viewerCSS) {
  let output;
  await generate(async () => source, async (path, css) => {
    assert.equal(path, "dist/assets/pdfjs/text-layer.css");
    output = css;
  });
  return output;
}

test("missing PDF.js helper styles fail the build instead of silently leaking visible canvases", async () => {
  const withoutHelpers = viewerCSS.replace(/#hiddenCopyElement,\s*\.hiddenCanvasElement\s*\{[^}]*\}/, "");
  await assert.rejects(generatedStyles(withoutHelpers), /PDF.js hidden helper CSS not found/);
});
