// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/gitlab-merge-request.ts"], bundle: true, write: false, format: "esm", platform: "browser" });
const { hasOpenMergeRequest } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const branch = "feature/paper";
const mr = { state: "opened", source_branch: branch, source_project_id: 42, target_project_id: 42 };

for (const [name, requests, expected] of [
  ["a matching MR becomes true", [mr], true],
  ["no matching MR becomes false", [], false],
]) {
  test(name, async () => {
    assert.equal(
      await hasOpenMergeRequest(
        {
          async pages() {
            return requests;
          },
        },
        42,
        branch,
      ),
      expected,
    );
  });
}

test("query errors propagate unchanged", async () => {
  const error = new Error("GitLab unavailable");
  await assert.rejects(
    hasOpenMergeRequest(
      {
        async pages() {
          throw error;
        },
      },
      42,
      branch,
    ),
    (actual) => actual === error,
  );
});
