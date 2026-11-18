// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({
  stdin: {
    contents: 'export { prepareTemplateProject } from "./src/projects/template-project.ts"; export { configureGitLab } from "./src/gitlab-submodules.ts";',
    resolveDir: new URL("../../", import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});
const { prepareTemplateProject, configureGitLab } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
configureGitLab("https://gitlab.example");

const sha = "a".repeat(40);
const childSHA = "b".repeat(40);
const templatePath = "team/templates/latex";
const limits = { snapshotBytes: 100000, snapshotFiles: 100, snapshotEntries: 200, submoduleDepth: 4, requestBytes: 200000 };
const file = (path, content, mode = "100644") => ({ path, content: Buffer.from(content), mode });

function fixture(t, { files = [file("main.tex", "Document\n")], metadata = {}, extra = {}, configLimits = {} } = {}) {
  const routes = new Map([
    [`projects/${encodeURIComponent(templatePath)}`, { id: 42, default_branch: "release/template", visibility: "public", ...metadata }],
    ["projects/42/repository/branches/release%2Ftemplate", { commit: { id: sha } }],
    [`projects/42/repository/tree?recursive=true&ref=${sha}`, files.map(({ path, mode }, i) => ({ path, mode, id: `blob-${i}`, type: "blob" }))],
    ...files.map(({ content }, i) => [`projects/42/repository/blobs/blob-${i}`, { content: content.toString("base64") }]),
    ...Object.entries(extra),
  ]);
  const calls = [];
  const failures = [];
  const request = async (endpoint, body) => {
    calls.push(endpoint);
    if (body !== undefined || !routes.has(endpoint)) {
      const error = new Error(`Unexpected API request: ${endpoint}`);
      failures.push(error.message);
      throw error;
    }
    const value = routes.get(endpoint);
    if (value instanceof Error) throw value;
    return structuredClone(value);
  };
  t.after(() => assert.deepEqual(failures, [], "Expected rejections must not hide unexpected API requests"));
  return {
    api: { request, pages: request },
    config: { templateRepository: templatePath, limits: { ...limits, ...configLimits } },
    calls,
    routes,
  };
}
const prepare = (f) => prepareTemplateProject(f.api, f.config, () => {});

function copiedFiles(commit) {
  return Object.fromEntries(commit.actions.filter((action) => action.action === "create").map((action) => {
    assert.equal(action.encoding, "base64");
    return [action.file_path, Buffer.from(action.content, action.encoding)];
  }));
}

test("template preparation pins the default branch and preserves binary files and executable mode in one initial commit", async (t) => {
  const binary = Buffer.from([0, 255, 128, 13, 10, 42]);
  const script = "#!/bin/sh\nprintf test\n";
  const f = fixture(t, { files: [file("main.tex", "Document\n"), file("figure.png", binary), file("build.sh", script, "100755")] });
  const prepared = await prepare(f);
  assert.equal(prepared.branch, "release/template");
  assert.equal(prepared.visibility, "public");
  assert.equal(prepared.commit.branch, "release/template");
  assert.deepEqual(copiedFiles(prepared.commit), { "main.tex": Buffer.from("Document\n"), "figure.png": binary, "build.sh": Buffer.from(script) });
  assert.deepEqual(prepared.commit.actions.filter((action) => action.action === "chmod"), [{ action: "chmod", file_path: "build.sh", execute_filemode: true }]);
  assert.ok(f.calls.includes(`projects/42/repository/tree?recursive=true&ref=${sha}`));
  assert.equal(prepared.commit.actions.length, 4);
});

test("template visibility is inherited rather than hardcoded to private", async (t) => {
  for (const visibility of ["private", "internal", "public"]) {
    const f = fixture(t, { metadata: { visibility } });
    assert.equal((await prepare(f)).visibility, visibility);
  }
});

test("submodules and symlinks become self-contained files without obsolete submodule mappings", async (t) => {
  const f = fixture(t, {
    files: [file(".gitmodules", '[submodule "lib"]\n path = vendor/lib\n url = https://gitlab.example/team/shared.git\n'), file("main.tex", "vendor/lib/shared.tex", "120000")],
    extra: {
      [`projects/team%2Fshared/repository/tree?recursive=true&ref=${childSHA}`]: [{ path: "shared.tex", id: "shared", type: "blob", mode: "100644" }],
      "projects/team%2Fshared/repository/blobs/shared": { content: Buffer.from("Shared source\n").toString("base64") },
    },
  });
  f.routes.get(`projects/42/repository/tree?recursive=true&ref=${sha}`).push({ path: "vendor/lib", id: childSHA, type: "commit", mode: "160000" });
  const { commit } = await prepare(f);
  assert.deepEqual(copiedFiles(commit), { "main.tex": Buffer.from("Shared source\n"), "vendor/lib/shared.tex": Buffer.from("Shared source\n") });
  assert.ok(commit.actions.every((action) => action.action === "create"));
});

test("unreadable or unusable templates fail before preparing a destination", async (t) => {
  const denied = fixture(t);
  const error = Object.assign(new Error("Template not accessible"), { status: 404 });
  denied.routes.set(`projects/${encodeURIComponent(templatePath)}`, error);
  await assert.rejects(prepare(denied), (value) => value === error);
  assert.equal(denied.calls.length, 1);

  for (const [metadata, message] of [[{ default_branch: null }, /no default branch/], [{ visibility: "unknown" }, /visibility/]]) {
    const f = fixture(t, { metadata });
    await assert.rejects(prepare(f), message);
    assert.equal(f.calls.length, 1);
  }
  await assert.rejects(prepare(fixture(t, { files: [] })), /no files to copy/);
});

test("unsafe symlinks and configured size limits reject the template before creation", async (t) => {
  const unsafe = fixture(t, { files: [file("main.tex", "/etc/passwd", "120000")] });
  await assert.rejects(prepare(unsafe), /Cannot materialize.*main\.tex/);
  for (const configLimits of [{ snapshotFiles: 1 }, { snapshotBytes: 1 }, { requestBytes: 1 }]) {
    const f = fixture(t, { files: [file("main.tex", "Document\n"), file("notes.txt", "Notes\n")], configLimits });
    await assert.rejects(prepare(f), /limit|exceeds/i);
  }
});
