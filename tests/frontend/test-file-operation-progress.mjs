// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/ui/file-operation-progress.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { fileOperationProgressText, createFileOperationProgress } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);

test("recursive downloads show completed counts without inventing a total or percentage", () => {
  assert.equal(fileOperationProgressText({ phase: "listing" }), "Reading file lists…");
  assert.equal(fileOperationProgressText({ phase: "downloading", completed: 17 }), "Downloading files: 17 downloaded…");
});

test("known file totals are shown for preparation and local import", () => {
  assert.equal(fileOperationProgressText({ phase: "preparing", completed: 0, total: 8 }), "Preparing files: 0/8…");
  assert.equal(fileOperationProgressText({ phase: "preparing", completed: 8, total: 8 }), "Preparing files: 8/8…");
  assert.equal(fileOperationProgressText({ phase: "importing", completed: 3, total: 8 }), "Importing files: 3/8…");
  assert.equal(fileOperationProgressText({ phase: "importing", completed: 0, total: 0 }), "Importing files: 0/0…");
});

test("unmeasured compilation, finalization, and rendering have phases but no fabricated progress", () => {
  assert.equal(fileOperationProgressText({ phase: "compiling" }), "Compiling document…");
  assert.equal(fileOperationProgressText({ phase: "finalizing" }), "Finalizing import…");
  assert.equal(fileOperationProgressText({ phase: "rendering" }), "Rendering preview…");
});

test("frequent counts are throttled but phase changes and exact completion appear immediately", () => {
  let time = 0;
  const messages = [];
  const progress = createFileOperationProgress(
    (message) => messages.push(message),
    () => time,
  );
  progress({ phase: "importing", completed: 0, total: 10 });
  time = 20;
  progress({ phase: "importing", completed: 1, total: 10 });
  time = 160;
  progress({ phase: "importing", completed: 8, total: 10 });
  time = 170;
  progress({ phase: "importing", completed: 10, total: 10 });
  progress({ phase: "finalizing" });
  assert.deepEqual(messages, ["Importing files: 0/10…", "Importing files: 8/10…", "Importing files: 10/10…", "Finalizing import…"]);
  assert.ok(messages.every((message) => !message.includes("%")));
});
