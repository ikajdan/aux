// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function load(path) {
  const result = await build({ entryPoints: [path], bundle: true, write: false, format: "esm", platform: "node" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { validateSnapshotSizes, validateRequestSize } = await load("src/workspace/snapshot-limits.ts");
const { configureGitLab, fetchSnapshot } = await load("src/gitlab-submodules.ts");
configureGitLab("https://gitlab.example.com");

test("upload limits accept exact byte and file boundaries and count encoded request bytes", () => {
  const limits = { snapshotFiles: 2, snapshotBytes: 5, requestBytes: 4 };
  validateSnapshotSizes([2, 3], limits);
  assert.throws(() => validateSnapshotSizes([2, 4], limits), /size limit/);
  assert.throws(() => validateSnapshotSizes([1, 1, 1], limits), /file limit/);
  validateRequestSize("éé", limits);
  assert.throws(() => validateRequestSize("ééa", limits), /upload limit/);
});

const sha = "a".repeat(40);
const file = (path) => ({ path, id: sha, type: "blob", mode: "100644" });
const limits = { snapshotBytes: 3, snapshotFiles: 1, snapshotEntries: 2, submoduleDepth: 0 };
function api(tree, content = "YWJj") {
  return { pages: async () => tree, request: async () => ({ content }) };
}
test("snapshot imports use configured byte, file, and entry limits", async () => {
  assert.equal((await fetchSnapshot(api([file("main.tex")]), 1, sha, "team/docs", limits)).files.length, 1);
  await assert.rejects(fetchSnapshot(api([file("main.tex")], "YWJjZA=="), 1, sha, "team/docs", limits), /compilation limits/);
  await assert.rejects(fetchSnapshot(api([file("a"), file("b")], "YQ=="), 1, sha, "team/docs", limits), /compilation limits/);
  await assert.rejects(fetchSnapshot(api([file("a"), file("b"), file("c")]), 1, sha, "team/docs", limits), /entry limit/);
});
test("zero configured submodule depth rejects children", async () => {
  const tree = [file(".gitmodules"), { path: "child", id: sha, type: "commit", mode: "160000" }];
  const content = Buffer.from('[submodule "child"]\npath = child\nurl = ../child.git\n').toString("base64");
  await assert.rejects(fetchSnapshot(api(tree, content), 1, sha, "team/docs", { ...limits, snapshotBytes: 1000 }), /depth exceeds 0/);
});
