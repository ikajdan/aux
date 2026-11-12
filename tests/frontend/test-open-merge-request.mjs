// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "browser" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { hasOpenMergeRequest } = await load("src/gitlab-merge-request.ts");
const { makeAPI } = await load("src/gitlab-sync.ts");
const branch = "feature/paper";
const mr = { state: "opened", source_branch: branch, target_branch: "main", source_project_id: 42, target_project_id: 42 };

function pagesAPI(t, result, project = 42, source = branch) {
  const calls = [];
  t.after(() => assert.deepEqual(calls, [`projects/${encodeURIComponent(project)}/merge_requests?state=opened&scope=all&source_branch=${encodeURIComponent(source)}`]));
  return {
    request() { assert.fail("Only the all-pages API should be used"); },
    async pages(endpoint) { calls.push(endpoint); return result; },
  };
}

for (const [name, requests, expected] of [
  ["current branch is the source", [mr], true],
  ["current branch is only the target", [{ ...mr, source_branch: "another", target_branch: branch }], false],
  ["same-named source branch belongs to a fork", [{ ...mr, source_project_id: 99 }], false],
  ["closed MR is ignored", [{ ...mr, state: "closed" }], false],
  ["merged MR is ignored", [{ ...mr, state: "merged" }], false],
  ["source branch must match exactly", [{ ...mr, source_branch: `${branch}-extra` }], false],
  ["no merge requests", [], false],
  ["valid source MR after unrelated results", [{ ...mr, source_project_id: 99 }, { ...mr, state: "closed" }, mr], true],
]) {
  test(name, async t => {
    assert.equal(await hasOpenMergeRequest(pagesAPI(t, requests), 42, branch), expected);
  });
}

test("encodes project paths and branch query values, without comparing numeric IDs to the project path", async t => {
  const project = "group/a project%";
  const source = "feature/é & #?%";
  assert.equal(await hasOpenMergeRequest(pagesAPI(t, [{ ...mr, source_branch: source }], project, source), project, source), true);
});

test("query errors propagate unchanged", async () => {
  const error = new Error("GitLab unavailable");
  await assert.rejects(hasOpenMergeRequest({ async pages() { throw error; } }, 42, branch), actual => actual === error);
});

test("finds a matching MR beyond the first page", async () => {
  const calls = [];
  const endpoint = "projects/42/merge_requests?state=opened&scope=all&source_branch=feature%2Fpaper";
  const api = makeAPI(() => "token", async url => {
    calls.push(url);
    return new Response(JSON.stringify(calls.length === 1 ? Array.from({ length: 100 }, () => ({ ...mr, source_project_id: 99 })) : [mr]));
  });
  assert.equal(await hasOpenMergeRequest(api, 42, branch), true);
  assert.deepEqual(calls, [`/api/${endpoint}&per_page=100&page=1`, `/api/${endpoint}&per_page=100&page=2`]);
});

test("later-page errors propagate even if the first page contains a match", async () => {
  const error = new Error("Second page failed");
  let calls = 0;
  const api = makeAPI(() => "token", async () => {
    if (++calls === 2) throw error;
    return new Response(JSON.stringify(Array.from({ length: 100 }, () => mr)));
  });
  await assert.rejects(hasOpenMergeRequest(api, 42, branch), actual => actual === error);
  assert.equal(calls, 2);
});
