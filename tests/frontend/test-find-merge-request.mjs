// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "browser" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { findOpenMergeRequest } = await load("src/gitlab-merge-request.ts");
const { makeAPI } = await load("src/gitlab-sync.ts");
const branch = "feature/paper";
const mr = { iid: 17, web_url: "https://gitlab.example/group/project/-/merge_requests/17", state: "opened", source_branch: branch, target_branch: "main", source_project_id: 42, target_project_id: 42 };

for (const [name, requests] of [
  ["no merge requests", []],
  ["fork source", [{ ...mr, source_project_id: 99 }]],
  ["closed request", [{ ...mr, state: "closed" }]],
  ["merged request", [{ ...mr, state: "merged" }]],
  ["branch is only the target", [{ ...mr, source_branch: "another", target_branch: branch }]],
  ["source must match exactly", [{ ...mr, source_branch: `${branch}-extra` }]],
]) {
  test(`returns null for ${name}`, async () => {
    assert.equal(await findOpenMergeRequest({ async pages() { return requests; } }, 42, branch), null);
  });
}

test("returns the first matched API object including iid and web_url", async () => {
  const requests = [{ ...mr, source_project_id: 99 }, { ...mr, state: "closed" }, mr, { ...mr, iid: 18 }];
  const result = await findOpenMergeRequest({ async pages() { return requests; } }, 42, branch);
  assert.strictEqual(result, mr);
  assert.equal(result.iid, 17);
  assert.equal(result.web_url, mr.web_url);
});

test("encodes project and source without restricting target branch", async () => {
  const project = "group/a project%";
  const source = "feature/é & #?%";
  const match = { ...mr, source_branch: source, target_branch: "release" };
  const api = {
    request() { assert.fail("Only the all-pages API should be used"); },
    async pages(endpoint) {
      assert.equal(endpoint, `projects/${encodeURIComponent(project)}/merge_requests?state=opened&scope=all&source_branch=${encodeURIComponent(source)}`);
      return [match];
    },
  };
  assert.strictEqual(await findOpenMergeRequest(api, project, source), match);
});

test("query errors propagate unchanged", async () => {
  const error = new Error("GitLab unavailable");
  await assert.rejects(findOpenMergeRequest({ async pages() { throw error; } }, 42, branch), actual => actual === error);
});

test("returns a matching MR beyond the first page", async () => {
  const calls = [];
  const endpoint = "projects/42/merge_requests?state=opened&scope=all&source_branch=feature%2Fpaper";
  const api = makeAPI(() => "token", async url => {
    calls.push(url);
    return new Response(JSON.stringify(calls.length === 1 ? Array.from({ length: 100 }, () => ({ ...mr, source_project_id: 99 })) : [mr]));
  });
  assert.deepEqual(await findOpenMergeRequest(api, 42, branch), mr);
  assert.deepEqual(calls, [`/api/${endpoint}&per_page=100&page=1`, `/api/${endpoint}&per_page=100&page=2`]);
});

test("later-page errors propagate even when the first page contains a match", async () => {
  const error = new Error("Second page failed");
  let calls = 0;
  const api = makeAPI(() => "token", async () => {
    if (++calls === 2) throw error;
    return new Response(JSON.stringify(Array.from({ length: 100 }, () => mr)));
  });
  await assert.rejects(findOpenMergeRequest(api, 42, branch), actual => actual === error);
  assert.equal(calls, 2);
});
