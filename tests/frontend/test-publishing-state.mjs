// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/workspace/publishing-state.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { publishingAvailability } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const state = { branch: "feature", targetBranch: "main", commitsKnown: true, unpublished: false, mergeRequestState: "none" };

test("push is disabled without unpublished commits, independently of MR creation", () => {
  assert.deepEqual(publishingAvailability(state), { pushDisabled: true, mergeRequestDisabled: false, mergeRequestChecking: false });
  assert.equal(publishingAvailability({ ...state, unpublished: true }).pushDisabled, false);
  assert.equal(publishingAvailability({ ...state, commitsKnown: false, unpublished: true }).pushDisabled, true);
});

test("an open MR disables MR creation but still allows pushing new commits", () => {
  const result = publishingAvailability({ ...state, unpublished: true, mergeRequestState: "open" });
  assert.equal(result.mergeRequestDisabled, true);
  assert.equal(result.pushDisabled, false);
});

test("MR checks block interaction temporarily without marking the section permanently unavailable", () => {
  const checking = publishingAvailability({ ...state, mergeRequestState: "checking" });
  assert.equal(checking.mergeRequestChecking, true);
  assert.equal(checking.mergeRequestDisabled, false);
  const failed = publishingAvailability({ ...state, mergeRequestState: "error" });
  assert.equal(failed.mergeRequestChecking, false);
  assert.equal(failed.mergeRequestDisabled, false);
});

test("non-main default branches disable self-targeting but main can be a working branch", () => {
  assert.equal(publishingAvailability({ ...state, branch: "develop", targetBranch: "develop" }).mergeRequestDisabled, true);
  assert.equal(publishingAvailability({ ...state, branch: "main", targetBranch: "develop" }).mergeRequestDisabled, false);
  assert.equal(publishingAvailability({ ...state, branch: "feature", targetBranch: undefined }).mergeRequestDisabled, true);
  assert.equal(publishingAvailability({ ...state, unpublished: true, targetBranch: undefined }).pushDisabled, false);
});

test("the target branch cannot open an MR into itself and no workspace disables both actions", () => {
  assert.equal(publishingAvailability({ ...state, branch: "main" }).mergeRequestDisabled, true);
  const absent = publishingAvailability({ ...state, branch: undefined });
  assert.equal(absent.pushDisabled, true);
  assert.equal(absent.mergeRequestDisabled, true);
});
