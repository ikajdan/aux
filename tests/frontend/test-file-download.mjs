// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/workspace/file-download.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "download-boundaries",
      setup(build) {
        build.onResolve({ filter: /\/ui\/(download-blob|project-zip)\.js$/ }, (args) => ({
          path: args.path,
          namespace: "download-test",
        }));
        build.onLoad({ filter: /.*/, namespace: "download-test" }, (args) => ({
          contents: args.path.endsWith("download-blob.js")
            ? "export const downloadBlob = (...args) => globalThis.downloadMocks.downloadBlob(...args);"
            : "export const createProjectZip = (...args) => globalThis.downloadMocks.createProjectZip(...args);",
        }));
      },
    },
  ],
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const calls = [],
    statuses = [],
    downloads = [],
    errors = [];
  const bytes = new Uint8Array([1, 2]);
  const zip = deferred(),
    zipStarted = deferred();
  const repo = {
    dir: "/original",
    files: async () => {
      calls.push("files");
      return ["main.tex", "assets/image.png"];
    },
    directories: async () => {
      calls.push("directories");
      return ["assets", "empty"];
    },
    p: {
      readFile: async (path) => {
        calls.push(path);
        return bytes;
      },
    },
  };
  const state = { context: { repo, file: "main.tex", projectName: "My: project. " }, version: 1 };
  const dependencies = {
    getContext: () => state.context,
    getReleaseForeground: () => async () => {
      calls.push("release");
    },
    getSaving: () => {
      calls.push("saving");
      return Promise.resolve();
    },
    getStatusVersion: () => state.version,
    resolveEditorDraft: async () => {
      calls.push("draft");
      return true;
    },
    readFile: async (path) => {
      calls.push(path);
      return bytes;
    },
    status: (...args) => {
      statuses.push(args);
      state.version++;
    },
  };
  const context = vm.createContext({
    module: { exports: {} },
    Blob,
    Uint8Array,
    console: { error: (error) => errors.push(error) },
    downloadMocks: {
      downloadBlob: (...args) => downloads.push(args),
      createProjectZip: (entries) => {
        calls.push("zip");
        zipStarted.resolve(entries);
        return zip.promise;
      },
    },
  });
  vm.runInContext(outputFiles[0].text, context);
  const actions = context.module.exports.createFileDownload(dependencies);
  return { ...actions, dependencies, state, repo, bytes, calls, statuses, downloads, errors, zip, zipStarted };
}

test("project snapshot waits for draft, saving, and every read before releasing", async () => {
  const f = fixture();
  const draft = deferred(),
    saving = deferred(),
    first = deferred(),
    last = deferred();
  f.dependencies.resolveEditorDraft = () => {
    f.calls.push("draft");
    return draft.promise;
  };
  f.dependencies.getSaving = () => {
    f.calls.push("saving");
    return saving.promise;
  };
  f.repo.p.readFile = (path) => {
    f.calls.push(path);
    return path.endsWith("main.tex") ? first.promise : last.promise;
  };
  const pending = f.downloadProject();
  assert.deepEqual(f.calls, ["draft"]);
  draft.resolve(true);
  await tick();
  assert.deepEqual(f.calls, ["draft", "saving"]);
  saving.resolve();
  await tick();
  assert.deepEqual(f.calls, ["draft", "saving", "files", "directories", "/original/main.tex"]);
  first.resolve(f.bytes);
  await tick();
  assert.equal(f.calls.at(-1), "/original/assets/image.png");
  assert.equal(f.calls.includes("release"), false);
  assert.equal(f.calls.includes("zip"), false);
  last.resolve(f.bytes);
  await f.zipStarted.promise;
  assert.deepEqual(f.calls.slice(-2), ["release", "zip"]);
  f.zip.resolve(new Uint8Array([9]));
  assert.equal((await pending).statusHandled, true);
  assert.deepEqual(f.statuses, [["Download project complete.", "ready"]]);
});

test("pending ZIP survives navigation with original name, directories, and copied bytes", async () => {
  const f = fixture();
  const pending = f.downloadProject();
  const entries = await f.zipStarted.promise;
  assert.deepEqual(f.calls.slice(-2), ["release", "zip"]);
  assert.equal(f.downloads.length, 0);
  f.state.context = { repo: { dir: "/other" }, file: "other.tex", projectName: "Other" };
  f.bytes.fill(8);
  assert.deepEqual(Object.keys(entries), ["My- project/", "My- project/assets/", "My- project/empty/", "My- project/main.tex", "My- project/assets/image.png"]);
  for (const path of ["My- project/main.tex", "My- project/assets/image.png"]) {
    assert.deepEqual([...entries[path]], [1, 2]);
  }
  assert.equal(entries["My- project/empty/"].length, 0);
  f.zip.resolve(new Uint8Array([3, 4]));
  await pending;
  const [[blob, name]] = f.downloads;
  assert.equal(name, "My- project.zip");
  assert.equal(blob.type, "application/zip");
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [3, 4]);
});

test("declined draft prevents both project and current-file snapshots", async () => {
  for (const action of ["downloadProject", "downloadFile"]) {
    const f = fixture();
    f.dependencies.resolveEditorDraft = async () => {
      f.calls.push("draft");
      return false;
    };
    assert.equal(await f[action]("main.tex"), false);
    assert.deepEqual(f.calls, ["draft"]);
    assert.deepEqual(f.downloads, []);
  }
});

test("snapshot read errors and unsafe paths retain the lock and never start ZIP creation", async () => {
  for (const unsafe of [false, true]) {
    const f = fixture();
    if (unsafe) f.repo.files = async () => ["../secret"];
    else
      f.repo.p.readFile = async () => {
        throw new Error("Read failed");
      };
    await assert.rejects(f.downloadProject(), unsafe ? /Unsafe path: \.\.\/secret/ : /Read failed/);
    assert.equal(f.calls.includes("release"), false);
    assert.equal(f.calls.includes("zip"), false);
    assert.deepEqual(f.downloads, []);
    assert.deepEqual(f.statuses, []);
  }
});

test("ZIP failure reports its own error after release without downloading", async () => {
  const f = fixture();
  const pending = f.downloadProject();
  await f.zipStarted.promise;
  const error = new Error("Worker failed");
  f.zip.reject(error);
  assert.equal((await pending).statusHandled, true);
  assert.deepEqual(f.statuses, [["Download project failed: Worker failed", "error"]]);
  assert.deepEqual(f.errors, [error]);
  assert.deepEqual(f.downloads, []);
});

test("late ZIP success and failure cannot overwrite a newer status", async () => {
  for (const fails of [false, true]) {
    const f = fixture();
    const pending = f.downloadProject();
    await f.zipStarted.promise;
    f.dependencies.status("New operation", "busy");
    if (fails) f.zip.reject(new Error("Late failure"));
    else f.zip.resolve(new Uint8Array([9]));
    assert.equal((await pending).statusHandled, true);
    assert.deepEqual(f.statuses, [["New operation", "busy"]]);
    assert.equal(f.downloads.length, fails ? 0 : 1);
  }
});

test("single-file download waits for saving, copies bytes before release, and skips unrelated draft", async () => {
  const f = fixture();
  const saving = deferred();
  f.dependencies.getSaving = () => {
    f.calls.push("saving");
    return saving.promise;
  };
  f.dependencies.getReleaseForeground = () => async () => {
    f.calls.push("release");
    f.bytes.fill(7);
    f.state.context = { repo: { dir: "/other" }, file: "other.tex" };
  };
  const pending = f.downloadFile("assets/image.png");
  assert.deepEqual(f.calls, ["saving"]);
  assert.equal(f.downloads.length, 0);
  saving.resolve();
  assert.equal((await pending).statusHandled, true);
  assert.deepEqual(f.calls, ["saving", "/original/assets/image.png", "release"]);
  const [[blob, name]] = f.downloads;
  assert.equal(name, "image.png");
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2]);
  assert.deepEqual(f.statuses, [["Download complete.", "ready"]]);
});
