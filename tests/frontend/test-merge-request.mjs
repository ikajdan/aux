// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/gitlab-merge-request.ts"], bundle: true, write: false, format: "esm", platform: "browser" });
const { publishMergeRequestBranch, createMergeRequest, validateMergeRequestBranch, getProjectDefaultBranch } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);

// Keep assertion failures outside production catch blocks as well as rejecting the call.
function strictAPI(t, steps) {
  let index = 0;
  const failures = [];
  const call = async (method, args) => {
    const step = steps[index++];
    try {
      assert.ok(step, `Unexpected ${method}: ${JSON.stringify(args)}`);
      assert.equal(method, step.method ?? "request");
      assert.deepEqual(args, step.args);
    } catch (error) {
      failures.push(error);
      throw error;
    }
    if (step.error) throw step.error;
    return step.result;
  };
  t.after(() => {
    assert.deepEqual(failures, [], "No unexpected API calls or payloads");
    assert.equal(index, steps.length, "All expected API calls completed");
  });
  return { request: (...args) => call("request", args), pages: (...args) => call("pages", args) };
}

const project = "group/a project";
const root = "projects/group%2Fa%20project";
const source = "feature/paper & figures".replaceAll(" ", "-");
const target = "release/v1";
const sourcePath = `${root}/repository/branches/feature%2Fpaper-%26-figures`;
const targetPath = `${root}/repository/branches/release%2Fv1`;
const baseline = "baseline-sha";
const author = { name: "Test Author", email: "test@example.invalid" };
const message = "Publish local changes";
const publication = { source, target, title: "Paper & figures", commit: "published-sha" };
const query = `${root}/merge_requests?state=opened&scope=all&source_branch=feature%2Fpaper-%26-figures&target_branch=release%2Fv1`;
const targetRead = { args: [targetPath], result: { commit: { id: baseline } } };
const reservation = { args: [`${root}/repository/branches`, { branch: source, ref: baseline }], result: {} };
const sourceRead = { args: [sourcePath], result: { commit: { id: baseline } } };
const publish = (api, actions = []) => publishMergeRequestBranch(api, project, source, target, baseline, message, author, actions);

test("merge requests use the GitLab project's default branch rather than assuming main", async (t) => {
  const created = { iid: 19, web_url: "https://gitlab.example/merge_requests/19" };
  const api = strictAPI(t, [
    { args: [root], result: { default_branch: target } },
    { method: "pages", args: [query], result: [] },
    { args: [sourcePath], result: { commit: { id: publication.commit } } },
    { args: [`${root}/merge_requests`, { source_branch: source, target_branch: target, title: publication.title }], result: created },
  ]);
  const defaultBranch = await getProjectDefaultBranch(api, project);
  assert.equal(defaultBranch, "release/v1");
  assert.deepEqual(await createMergeRequest(api, project, { ...publication, target: defaultBranch }), created);
});

test("projects without a default branch fail clearly instead of falling back to main", async () => {
  for (const default_branch of [null, undefined, "", " "]) {
    await assert.rejects(getProjectDefaultBranch({ request: async () => ({ default_branch }) }, 1), /no default branch configured/);
  }
});

test("default branch lookups do not hide permission or network errors", async () => {
  const error = new Error("GitLab unavailable");
  await assert.rejects(
    getProjectDefaultBranch(
      {
        request: async () => {
          throw error;
        },
      },
      1,
    ),
    (actual) => actual === error,
  );
});

test("stale target baseline aborts before any write", async (t) => {
  const api = strictAPI(t, [{ ...targetRead, result: { commit: { id: "new-target-sha" } } }]);
  await assert.rejects(publish(api), /Current branch has changed.*Pull\/reconcile/);
});

test("failed branch reservation sends no commit or file reads", async (t) => {
  const api = strictAPI(t, [targetRead, { ...reservation, error: new Error("Branch already exists") }]);
  await assert.rejects(
    publish(api, [{ action: "update", file_path: "paper.tex", content: "new" }]),
    /Could not reserve new branch.*No commit was sent.*Branch already exists/,
  );
});

test("source changed after reservation aborts without committing", async (t) => {
  const api = strictAPI(t, [targetRead, reservation, { ...sourceRead, result: { commit: { id: "someone-elses-commit" } } }]);
  await assert.rejects(publish(api), /Local work is retained.*New branch changed before publication\. No commit sent/);
});

test("publication uses baseline file guards, encoded paths and exact commit payload without mutating actions", async (t) => {
  const actions = [
    { action: "update", file_path: "chapters/a & b.tex", content: "bmV3", encoding: "base64", last_commit_id: "stale-guard" },
    { action: "delete", file_path: "old/#draft%.tex" },
    { action: "create", file_path: "new/figure.svg", content: "PHN2Zy8+", encoding: "base64" },
    { action: "chmod", file_path: "tools/run.sh", execute_filemode: true },
  ];
  const before = structuredClone(actions);
  const api = strictAPI(t, [
    targetRead,
    reservation,
    { args: [`${root}/repository/files/chapters%2Fa%20%26%20b.tex?ref=baseline-sha`], result: { last_commit_id: "update-file-sha" } },
    { args: [`${root}/repository/files/old%2F%23draft%25.tex?ref=baseline-sha`], result: { last_commit_id: "delete-file-sha" } },
    sourceRead,
    {
      args: [
        `${root}/repository/commits`,
        {
          branch: source,
          commit_message: message,
          author_name: author.name,
          author_email: author.email,
          actions: [{ ...actions[0], last_commit_id: "update-file-sha" }, { ...actions[1], last_commit_id: "delete-file-sha" }, actions[2], actions[3]],
        },
      ],
      result: { id: publication.commit },
    },
  ]);
  assert.equal(await publish(api, actions), publication.commit);
  assert.deepEqual(actions, before);
});

test("file guard lookup failure retains local work and sends no commit", async (t) => {
  const api = strictAPI(t, [
    targetRead,
    reservation,
    {
      args: [`${root}/repository/files/paper.tex?ref=baseline-sha`],
      error: new Error("File lookup failed"),
    },
  ]);
  await assert.rejects(publish(api, [{ action: "delete", file_path: "paper.tex" }]), /Local work is retained.*File lookup failed/);
});

test("retry finds existing MR and never rechecks source or creates a duplicate", async (t) => {
  const existing = {
    iid: 17,
    web_url: "https://gitlab.example/merge_requests/17",
    state: "opened",
    source_branch: source,
    target_branch: target,
    source_project_id: 42,
    target_project_id: 42,
  };
  const api = strictAPI(t, [{ method: "pages", args: [query], result: [{ ...existing, source_project_id: 99 }, existing, { ...existing, iid: 18 }] }]);
  assert.deepEqual(await createMergeRequest(api, project, publication), existing);
});

for (const [name, overrides] of [
  ["fork source", { source_project_id: 99 }],
  ["different source", { source_branch: `${source}-other` }],
  ["different target", { target_branch: "main" }],
  ["closed MR", { state: "closed" }],
  ["merged MR", { state: "merged" }],
  ["unknown projects", { source_project_id: null, target_project_id: null }],
]) {
  test(`creation ignores ${name} and uses the given current branch without creating a branch`, async (t) => {
    const unrelated = {
      iid: 17,
      web_url: "https://gitlab.example/merge_requests/17",
      state: "opened",
      source_branch: source,
      target_branch: target,
      source_project_id: 42,
      target_project_id: 42,
      ...overrides,
    };
    const created = { iid: 19, web_url: "https://gitlab.example/merge_requests/19" };
    const api = strictAPI(t, [
      { method: "pages", args: [query], result: [unrelated] },
      { args: [sourcePath], result: { commit: { id: publication.commit } } },
      { args: [`${root}/merge_requests`, { source_branch: source, target_branch: target, title: publication.title }], result: created },
    ]);
    assert.strictEqual(await createMergeRequest(api, project, publication), created);
  });
}

test("changed published source prevents MR creation", async (t) => {
  const api = strictAPI(t, [
    { method: "pages", args: [query], result: [] },
    { args: [sourcePath], result: { commit: { id: "changed-after-publication" } } },
  ]);
  await assert.rejects(createMergeRequest(api, project, publication), /Published source branch changed.*Review it/);
});

test("unchanged published source creates MR with exact payload and returns result", async (t) => {
  const created = { iid: 19, web_url: "https://gitlab.example/merge_requests/19" };
  const api = strictAPI(t, [
    { method: "pages", args: [query], result: [] },
    { args: [sourcePath], result: { commit: { id: publication.commit } } },
    { args: [`${root}/merge_requests`, { source_branch: source, target_branch: target, title: publication.title }], result: created },
  ]);
  assert.deepEqual(await createMergeRequest(api, project, publication), created);
});

const invalidBranches = [
  "",
  target,
  "@",
  "-topic",
  "a b",
  "a\tb",
  "a\x00b",
  "a\x7fb",
  "a~b",
  "a^b",
  "a:b",
  "a?b",
  "a*b",
  "a[b",
  "a\\b",
  "a..b",
  "a@{b",
  "/topic",
  "topic/",
  "a//b",
  ".topic",
  "a/.topic",
  "topic.",
  "a/topic.lock",
];
for (const branch of invalidBranches) {
  test(`invalid source branch ${JSON.stringify(branch)} is rejected before network access`, async (t) => {
    assert.throws(() => validateMergeRequestBranch(branch, target), /Choose a new branch|Enter a valid Git branch name/);
    await assert.rejects(
      publishMergeRequestBranch(strictAPI(t, []), project, branch, target, baseline, message, author, []),
      /Choose a new branch|Enter a valid Git branch name/,
    );
  });
}

test("valid branch names include nested, Unicode and lock-like names", () => {
  for (const branch of ["feature/paper", "fix-123", "v1.2", "écriture/修正", "topic.locked", "a@b", source]) {
    assert.doesNotThrow(() => validateMergeRequestBranch(branch, target));
  }
});
