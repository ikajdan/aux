// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDocumentBuild } from "./helpers/document-build.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const response = deferred();
  const requested = deferred();
  const calls = [];
  let current = true;
  const controller = new AbortController();
  const context = {
    repo: { dir: "/workspace", modes: {}, files: async () => ["main.tex"] },
    saving: Promise.resolve(),
    saveDocument: async () => { calls.push("save"); },
    fs: { promises: { readFile: async () => { calls.push("read"); return new Uint8Array([1]); } } },
    serverConfig: { limits: {} },
    validateRequestSize: () => { calls.push("validate"); },
    builtPdf: null,
    updateLog: () => { calls.push("log"); },
    selectOutputTab: () => { calls.push("tab"); },
    preview: async () => { calls.push("preview"); return true; },
    updatePdfDownload: () => { calls.push("download"); },
  };
  const createDocumentBuild = loadDocumentBuild({
    validateRequestSize: (...args) => context.validateRequestSize(...args),
  });
  const { compileDocument } = createDocumentBuild({
    getRepo: () => context.repo,
    getSaving: () => context.saving,
    getLimits: () => context.serverConfig.limits,
    saveDocument: () => context.saveDocument(),
    fs: context.fs,
    status: () => {},
    getBuiltPdf: () => context.builtPdf,
    updateLog: (...args) => context.updateLog(...args),
    selectLogs: () => context.selectOutputTab(),
    preview: (...args) => context.preview(...args),
    setBuiltPdf: (pdf) => { context.builtPdf = pdf; },
    updatePdfDownload: () => context.updatePdfDownload(),
  });
  const operation = {
    id: "build",
    signal: controller.signal,
    request: async (body) => {
      calls.push("request");
      requested.resolve(JSON.parse(body));
      return response.promise;
    },
  };
  return {
    context, calls, response, requested,
    invalidate: () => { current = false; },
    build: (release = async () => { calls.push("release"); }) => compileDocument(
      operation, () => { calls.push("commit"); }, release, () => current,
    ),
    complete: () => response.resolve({ ok: true, json: async () => ({ pdf: "Ag==", log: "Built", synctex: "sync" }) }),
  };
}

test("build releases navigation only after validating the immutable request snapshot", async () => {
  const f = fixture();
  const pending = f.build();
  const body = await f.requested.promise;
  assert.deepEqual(f.calls, ["save", "read", "validate", "release", "request"]);
  assert.deepEqual(body.files, [{ path: "main.tex", content: "AQ==" }]);
  assert.equal(f.context.builtPdf, null);
  f.complete();
  await pending;
  assert.deepEqual(f.calls.slice(-4), ["log", "preview", "commit", "download"]);
  assert.ok(f.context.builtPdf instanceof Blob);
});

test("snapshot validation failure does not release the foreground lock or send a request", async () => {
  const f = fixture();
  f.context.validateRequestSize = () => { throw new Error("Too large"); };
  await assert.rejects(f.build(), /Too large/);
  assert.deepEqual(f.calls, ["save", "read"]);
});

test("a response for a workspace left during compilation cannot publish logs or PDF", async () => {
  const f = fixture();
  const pending = f.build();
  await f.requested.promise;
  f.context.repo = { dir: "/other" };
  f.complete();
  await pending;
  assert.equal(f.context.builtPdf, null);
  assert.equal(f.calls.includes("log"), false);
  assert.equal(f.calls.includes("preview"), false);
});

test("a newer build invalidates an old response even in the same repository", async () => {
  const f = fixture();
  const pending = f.build();
  await f.requested.promise;
  f.invalidate();
  f.complete();
  await pending;
  assert.equal(f.calls.includes("log"), false);
  assert.equal(f.context.builtPdf, null);
});

test("workspace change during PDF rendering cannot publish the download", async () => {
  const f = fixture();
  const rendering = deferred();
  const shown = deferred();
  f.context.preview = () => { shown.resolve(); return rendering.promise; };
  const pending = f.build();
  await f.requested.promise;
  f.complete();
  await shown.promise;
  f.context.repo = { dir: "/other" };
  rendering.resolve(true);
  await pending;
  assert.equal(f.context.builtPdf, null);
  assert.equal(f.calls.includes("commit"), false);
  assert.equal(f.calls.includes("download"), false);
});
test("superseded PDF rendering cannot publish a download even without a repository change", async () => {
  const f = fixture();
  f.context.preview = async () => false;
  const pending = f.build();
  await f.requested.promise;
  f.complete();
  await pending;
  assert.equal(f.context.builtPdf, null);
  assert.equal(f.calls.includes("commit"), false);
});

test("ownership lost while decoding response JSON cannot publish logs or PDF", async () => {
  const f = fixture();
  const json = deferred();
  const decoding = deferred();
  const pending = f.build();
  await f.requested.promise;
  f.response.resolve({ ok: true, json: () => { decoding.resolve(); return json.promise; } });
  await decoding.promise;
  f.invalidate();
  json.resolve({ pdf: "Ag==", log: "Stale" });
  await pending;
  assert.equal(f.calls.includes("log"), false);
  assert.equal(f.calls.includes("preview"), false);
  assert.equal(f.context.builtPdf, null);
});

for (const stage of ["saveDocument", "readFile"]) {
  test(`${stage} failure does not release navigation or send a request`, async () => {
    const f = fixture();
    const fail = async () => { throw new Error("Storage unavailable"); };
    if (stage === "readFile") f.context.fs.promises.readFile = fail;
    else f.context.saveDocument = fail;
    await assert.rejects(f.build(), /Storage unavailable/);
    assert.equal(f.calls.includes("release"), false);
    assert.equal(f.calls.includes("request"), false);
  });
}
