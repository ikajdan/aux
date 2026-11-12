// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/browser-storage.ts"], bundle: true, write: false, format: "esm", platform: "browser" });
const { readStorage, readStoredJSON, loadSettings, loadProjects, loadWorkspaces } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);
const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
function storage(t, getItem) {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  });
}

test("startup reads survive unavailable storage, including a throwing getter", (t) => {
  storage(t, () => {
    throw new Error("SecurityError");
  });
  for (let mode = 0; mode < 2; mode++) {
    if (mode)
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get() {
          throw new Error("SecurityError");
        },
      });
    assert.equal(readStorage("aux-theme"), null);
    assert.deepEqual(loadSettings(), {});
    assert.deepEqual(loadProjects(), []);
    assert.deepEqual(Object.keys(loadWorkspaces()), []);
  }
});

test("malformed JSON and incorrect top-level shapes use defaults without altering storage", (t) => {
  let raw;
  storage(t, () => raw);
  for (raw of [null, "{broken", "null", "42", '"text"', "true", "[]"]) {
    assert.deepEqual(loadSettings(), {});
    assert.deepEqual(loadProjects(), []);
    assert.deepEqual(Object.keys(loadWorkspaces()), []);
  }
  raw = "{broken";
  assert.equal(readStoredJSON("anything"), null);
});

test("settings retain only valid known fields", (t) => {
  storage(t, () => JSON.stringify({ token: "token", author: [], email: null, paneRatio: 500, extra: "ignored" }));
  assert.deepEqual(loadSettings(), { token: "token" });
  globalThis.localStorage.getItem = () => JSON.stringify({ author: "Author", email: "a@example.com", paneRatio: 60 });
  assert.deepEqual(loadSettings(), { author: "Author", email: "a@example.com", paneRatio: 60 });
});

test("custom repository settings survive reload and reject malformed stored lists", (t) => {
  storage(t, () => JSON.stringify({ customRepositories: ["team/project", "personal/notes"] }));
  assert.deepEqual(loadSettings().customRepositories, ["team/project", "personal/notes"]);
  for (const customRepositories of [null, "team/project", ["team/project", 42]]) {
    globalThis.localStorage.getItem = () => JSON.stringify({ customRepositories });
    assert.equal(loadSettings().customRepositories, undefined);
  }
  globalThis.localStorage.getItem = () => JSON.stringify({ customRepositories: [] });
  assert.deepEqual(loadSettings().customRepositories, []);
});

test("project cache retains GitLab topics and rejects malformed topic arrays", (t) => {
  const project = { id: 1, path_with_namespace: "group/project", topics: ["sbc", "datasheet"] };
  storage(t, () => JSON.stringify([project, { ...project, id: 2, topics: "sbc" }, { ...project, id: 3, topics: [null] }]));
  assert.deepEqual(loadProjects(), [project]);
});

test("workspace publication receipts survive reload without changing the upstream baseline", (t) => {
  const workspace = {
    project: 1,
    branch: "main",
    dir: "/source",
    base: "local-baseline",
    remote: "remote-baseline",
    modes: {},
    publication: { localHead: "published-local-head", branch: "feature", remoteCommit: "feature-commit" },
  };
  storage(t, () => JSON.stringify({ "1:main": workspace }));
  const restored = loadWorkspaces()["1:main"];
  assert.deepEqual(restored, workspace);
  assert.equal(restored.base, "local-baseline");
  assert.equal(restored.remote, "remote-baseline");
  for (const publication of [null, {}, { ...workspace.publication, localHead: 42 }, { ...workspace.publication, branch: "" }]) {
    globalThis.localStorage.getItem = () => JSON.stringify({ "1:main": { ...workspace, publication } });
    assert.equal(loadWorkspaces()["1:main"], undefined);
  }
});

test("invalid cached projects and workspaces do not discard valid neighbours", (t) => {
  const project = { id: 1, name: "Project", path_with_namespace: "group/project", latestTag: null };
  const workspace = {
    project: 1,
    branch: "main",
    dir: "/p-1-id",
    base: "abc",
    remote: "abc",
    modes: { "run.sh": "100755" },
    links: [{ path: "vendor", oid: "def" }],
  };
  storage(t, (key) =>
    JSON.stringify(
      key === "aux-projects"
        ? [null, {}, { ...project, name: [] }, project]
        : {
            "1:main": workspace,
            bad: null,
            "1:bad": { ...workspace, branch: "bad", links: [null] },
            "1:legacy": { ...workspace, branch: "legacy", modes: undefined },
          },
    ),
  );
  assert.deepEqual(loadProjects(), [project]);
  const workspaces = loadWorkspaces();
  assert.deepEqual(Object.keys(workspaces), ["1:main", "1:legacy"]);
  assert.deepEqual(workspaces["1:main"], workspace);
  assert.deepEqual(workspaces["1:legacy"].modes, {});
});
