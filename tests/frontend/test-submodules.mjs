// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({
  entryPoints: [new URL("../../src/gitlab-submodules.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});
const { configureGitLab, fetchSnapshot } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
configureGitLab("https://gitlab.example.com");

// Record mock failures separately so an expected rejection cannot hide a bad API call.
function strictAPI(t, steps) {
  let index = 0;
  const failures = [];
  const call = async (method, args) => {
    const step = steps[index++];
    try {
      assert.ok(step, `Unexpected ${method}: ${JSON.stringify(args)}`);
      assert.equal(method, step.method);
      assert.deepEqual(args, [step.path]);
    } catch (error) {
      failures.push(error);
      throw error;
    }
    if (step.error) throw step.error;
    return structuredClone(step.result);
  };
  t.after(() => {
    assert.deepEqual(failures, [], "No unexpected API calls or arguments");
    assert.equal(index, steps.length, "All expected API calls completed");
  });
  return {
    pages: (...args) => call("pages", args),
    request: (...args) => call("request", args),
  };
}

const rootSHA = "a".repeat(40);
const childSHA = "b".repeat(40);
const nestedSHA = "c".repeat(40);
const namespace = "team/paper";
const rootID = 42;
const endpoint = (project) => `projects/${encodeURIComponent(project)}/repository`;
const tree = (project, sha, entries) => ({
  method: "pages",
  path: `${endpoint(project)}/tree?recursive=true&ref=${sha}`,
  result: entries,
});
const blob = (project, id, data) => ({
  method: "request",
  path: `${endpoint(project)}/blobs/${id}`,
  result: { content: Buffer.from(data).toString("base64") },
});
const file = (path, id, mode = "100644") => ({ path, id, type: "blob", mode });
const link = (path, id = childSHA) => ({ path, id, type: "commit", mode: "160000" });
const directory = (path) => ({ path, id: "d".repeat(40), type: "tree", mode: "040000" });
const modules = (path, url, extra = "") => `[submodule "dependency"]\n path = ${path}\n url = ${url}\n${extra}`;
const fetchRoot = (api) => fetchSnapshot(api, rootID, rootSHA, namespace);

// These steps deliberately stop before a child tree request.
function mappedRoot(url, sha = childSHA) {
  return [
    tree(rootID, rootSHA, [file(".gitmodules", "mapping"), link("vendor/lib", sha)]),
    blob(rootID, "mapping", modules("vendor/lib", url, " branch = moving-branch\n")),
  ];
}

test("recursive import pins every tree to its gitlink SHA and preserves bytes, modes, prefixes and links", async (t) => {
  const child = "team/lib";
  const nested = "shared/assets";
  const rootModules = modules("vendor/lib", "../lib.git", " branch = main\n");
  const childModules = modules("deps/assets", "git@gitlab.example.com:shared/assets.git", " branch = develop\n");
  const binary = Uint8Array.of(0, 255, 128, 13, 10, 195, 40);
  const executable = Uint8Array.of(35, 33, 10, 0, 254);
  const api = strictAPI(t, [
    tree(rootID, rootSHA, [directory("vendor"), file(".gitmodules", "root-modules"), file("paper.bin", "root-data"), link("vendor/lib")]),
    blob(rootID, "root-modules", rootModules),
    blob(rootID, "root-data", binary),
    tree(child, childSHA, [
      file(".gitmodules", "child-modules"),
      directory("bin"),
      file("bin/run", "executable", "100755"),
      directory("deps"),
      link("deps/assets", nestedSHA),
    ]),
    blob(child, "child-modules", childModules),
    blob(child, "executable", executable),
    tree(nested, nestedSHA, [file("figure.bin", "nested-data"), file("empty", "empty-data")]),
    blob(nested, "nested-data", binary),
    blob(nested, "empty-data", new Uint8Array()),
  ]);
  const progress = [];
  const calls = [];
  const observedAPI = {
    pages: (path) => {
      calls.push({ path, progress: progress.at(-1) });
      return api.pages(path);
    },
    request: (path) => {
      calls.push({ path, progress: progress.at(-1) });
      return api.request(path);
    },
  };
  const snapshot = await fetchSnapshot(observedAPI, rootID, rootSHA, namespace, undefined, (event) => progress.push(event));
  const listing = (files, repository) => ({ phase: "listing", files, repository });
  const downloading = (files, repository) => ({ phase: "downloading", files, repository });
  assert.deepEqual(progress, [
    listing(0, namespace),
    downloading(1, namespace),
    downloading(2, namespace),
    listing(2, child),
    downloading(3, child),
    downloading(4, child),
    listing(4, nested),
    downloading(5, nested),
    downloading(6, nested),
  ]);
  assert.deepEqual(calls, [
    { path: tree(rootID, rootSHA, []).path, progress: listing(0, namespace) },
    { path: blob(rootID, "root-modules", "").path, progress: listing(0, namespace) },
    { path: blob(rootID, "root-data", "").path, progress: listing(0, namespace) },
    { path: tree(child, childSHA, []).path, progress: listing(2, child) },
    { path: blob(child, "child-modules", "").path, progress: listing(2, child) },
    { path: blob(child, "executable", "").path, progress: listing(2, child) },
    { path: tree(nested, nestedSHA, []).path, progress: listing(4, nested) },
    { path: blob(nested, "nested-data", "").path, progress: listing(4, nested) },
    { path: blob(nested, "empty-data", "").path, progress: listing(4, nested) },
  ]);
  assert.deepEqual(snapshot, {
    files: [
      { path: ".gitmodules", bytes: new TextEncoder().encode(rootModules), mode: "100644" },
      { path: "paper.bin", bytes: binary, mode: "100644" },
      { path: "vendor/lib/.gitmodules", bytes: new TextEncoder().encode(childModules), mode: "100644" },
      { path: "vendor/lib/bin/run", bytes: executable, mode: "100755" },
      { path: "vendor/lib/deps/assets/figure.bin", bytes: binary, mode: "100644" },
      { path: "vendor/lib/deps/assets/empty", bytes: new Uint8Array(), mode: "100644" },
    ],
    links: [
      { path: "vendor/lib", oid: childSHA, project: child },
      { path: "vendor/lib/deps/assets", oid: nestedSHA, project: nested },
    ],
  });
});

test("blob downloads run in a bounded pool while snapshot order remains deterministic", async () => {
  const entries = Array.from({ length: 17 }, (_, index) => file(`file-${index}.tex`, `blob-${index}`, index === 3 ? "100755" : "100644"));
  const pending = new Map();
  let active = 0;
  let maximum = 0;
  const started = [];
  const progress = [];
  const api = {
    pages: async () => entries,
    request: (endpoint) => {
      const id = endpoint.split("/").pop();
      started.push(id);
      active++;
      maximum = Math.max(maximum, active);
      return new Promise((resolve) =>
        pending.set(id, () => {
          pending.delete(id);
          active--;
          resolve({ content: Buffer.from(id).toString("base64") });
        }),
      );
    },
  };
  const importing = fetchSnapshot(api, rootID, rootSHA, namespace, undefined, (event) => progress.push(event));
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  await tick();
  assert.equal(started.length, 8, "eight requests start before any download completes");
  assert.equal(active, 8);
  for (let batch = 0; pending.size && batch < 10; batch++) {
    for (const finish of [...pending.values()].reverse()) finish();
    await tick();
  }
  assert.equal(pending.size, 0);
  const snapshot = await importing;
  assert.equal(maximum, 8);
  assert.equal(active, 0);
  assert.deepEqual(
    snapshot.files.map((entry) => entry.path),
    entries.map((entry) => entry.path),
  );
  assert.deepEqual(
    snapshot.files.map((entry) => new TextDecoder().decode(entry.bytes)),
    entries.map((entry) => entry.id),
  );
  assert.equal(snapshot.files[3].mode, "100755");
  assert.deepEqual(
    progress.filter((event) => event.phase === "downloading").map((event) => event.files),
    Array.from({ length: 17 }, (_, index) => index + 1),
  );
});

test("download failures stop queued work and drain in-flight requests without late progress", async () => {
  const entries = Array.from({ length: 12 }, (_, index) => file(`file-${index}`, `blob-${index}`));
  const pending = [];
  const progress = [];
  let started = 0;
  const api = {
    pages: async () => entries,
    request: () => {
      started++;
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
  let settled = false;
  const result = fetchSnapshot(api, rootID, rootSHA, namespace, undefined, (event) => progress.push(event)).then(
    () => {
      throw new Error("Import unexpectedly succeeded");
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  await tick();
  assert.equal(started, 8);
  const failure = new Error("Download failed");
  pending[0].reject(failure);
  await tick();
  assert.equal(settled, false, "import waits for existing requests to drain");
  for (const request of pending.slice(1)) request.resolve({ content: Buffer.from("ignored after failure").toString("base64") });
  assert.equal(await result, failure);
  assert.equal(started, 8, "queued files are never requested after failure");
  assert.deepEqual(progress, [{ phase: "listing", files: 0, repository: namespace }]);
  await tick();
  assert.equal(progress.length, 1);
});

test("progress does not count files that fail download, decoding, limits or mapping parsing", async (t) => {
  const limits = { snapshotBytes: 1000, snapshotFiles: 10, snapshotEntries: 100, submoduleDepth: 8 };
  const cases = [
    { name: "blob request", step: { ...blob(rootID, "bad", ""), error: new Error("Blob unavailable") }, error: /Blob unavailable/ },
    { name: "blob decoding", step: { ...blob(rootID, "bad", ""), result: { content: "!invalid!" } }, error: { name: "InvalidCharacterError" } },
    { name: "byte limit", step: blob(rootID, "bad", "too large"), limits: { ...limits, snapshotBytes: 2 }, error: /compilation limits/ },
    { name: "file limit", step: blob(rootID, "bad", ""), limits: { ...limits, snapshotFiles: 1 }, error: /compilation limits/ },
    {
      name: "mapping parsing",
      path: ".gitmodules",
      links: [link("vendor/lib")],
      step: blob(rootID, "bad", "invalid syntax"),
      error: /Unsupported \.gitmodules syntax/,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const progress = [];
      const api = strictAPI(t, [
        tree(rootID, rootSHA, [file("good", "good"), file(scenario.path ?? "bad", "bad"), ...(scenario.links ?? [])]),
        blob(rootID, "good", "ok"),
        scenario.step,
      ]);
      await assert.rejects(
        fetchSnapshot(api, rootID, rootSHA, namespace, scenario.limits ?? limits, (event) => progress.push(event)),
        scenario.error,
      );
      assert.deepEqual(progress, [
        { phase: "listing", files: 0, repository: namespace },
        { phase: "downloading", files: 1, repository: namespace },
      ]);
    });
  }
});

test("unsafe or duplicate tree paths reject the entire tree before blob reads", async (t) => {
  const invalidTrees = [
    [file("valid.txt", "valid"), file("../escape", "unsafe")],
    [file("valid.txt", "valid"), file("nested/.GiT/config", "unsafe")],
    [file("same", "first"), file("same", "second")],
  ];
  for (const entries of invalidTrees) {
    const api = strictAPI(t, [tree(rootID, rootSHA, entries)]);
    await assert.rejects(fetchRoot(api), /Unsafe path:|Duplicate tree path/);
  }
});

test("symlink blobs are imported as link targets with their Git mode preserved", async (t) => {
  const api = strictAPI(t, [
    tree(rootID, rootSHA, [file(".latexmkrc", "link-target", "120000"), file("tools/latexmkrc", "config")]),
    blob(rootID, "link-target", "tools/latexmkrc"),
    blob(rootID, "config", "$pdf_mode = 5;\n"),
  ]);
  const snapshot = await fetchRoot(api);
  assert.equal(snapshot.files[0].mode, "120000");
  assert.equal(new TextDecoder().decode(snapshot.files[0].bytes), "tools/latexmkrc");
  assert.equal(snapshot.files[1].mode, "100644");
});

test("unknown file modes remain rejected before downloading blobs", async (t) => {
  const api = strictAPI(t, [tree(rootID, rootSHA, [file("shortcut", "target", "100664")])]);
  await assert.rejects(fetchRoot(api), /Unsupported tree entry: shortcut.*100664/);
});

test("a descendant under a gitlink is rejected before reading mappings or blobs", async (t) => {
  const api = strictAPI(t, [tree(rootID, rootSHA, [file(".gitmodules", "mapping"), file("vendor/lib/injected.txt", "injected"), link("vendor/lib")])]);
  await assert.rejects(fetchRoot(api), /Overlapping submodule tree/);
});

test("missing submodule mappings never trigger a child request", async (t) => {
  const absent = strictAPI(t, [tree(rootID, rootSHA, [link("vendor/lib")])]);
  await assert.rejects(fetchRoot(absent), /Missing \.gitmodules mapping: vendor\/lib/);
  const unrelated = strictAPI(t, [
    tree(rootID, rootSHA, [file(".gitmodules", "mapping"), link("vendor/lib")]),
    blob(rootID, "mapping", modules("other/lib", "../other.git")),
  ]);
  await assert.rejects(fetchRoot(unrelated), /Missing \.gitmodules mapping: vendor\/lib/);
});

test("foreign-host and credential-bearing URLs reject before child network access", async (t) => {
  for (const url of ["https://foreign.invalid/team/lib.git", "https://user:secret@gitlab.example.com/team/lib.git"]) {
    const api = strictAPI(t, mappedRoot(url));
    await assert.rejects(fetchRoot(api), /Submodule URL must use the configured GitLab instance/);
  }
});

test("an ancestor project at the same SHA is a cycle and is not fetched again", async (t) => {
  const child = "team/lib";
  const api = strictAPI(t, [
    ...mappedRoot("../lib.git"),
    tree(child, childSHA, [file(".gitmodules", "child-mapping"), link("back", rootSHA)]),
    blob(child, "child-mapping", modules("back", "../paper.git")),
  ]);
  await assert.rejects(fetchRoot(api), /Submodule cycle/);
});

test("invalid root and child SHAs reject before fetching their trees", async (t) => {
  const rootAPI = strictAPI(t, []);
  await assert.rejects(fetchSnapshot(rootAPI, rootID, "main", namespace), /Invalid pinned commit/);
  const childAPI = strictAPI(t, mappedRoot("../lib.git", "b".repeat(39) + "g"));
  await assert.rejects(fetchRoot(childAPI), /Invalid pinned commit/);
});
