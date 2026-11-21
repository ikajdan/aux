// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { loadDocumentBuild } from "./helpers/document-build.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const success = { ok: true, json: async () => ({ pdf: "AQ==", log: "Built", synctex: "sync" }) };
function fixture({ cancellation = Promise.resolve(), pdf = null } = {}) {
  const state = { repo: { dir: "/workspace", modes: {}, files: async () => [] }, pdf, operation: null, version: 0 };
  const button = { disabled: false };
  const cancel = { hidden: true, onclick: null };
  const statuses = [],
    operations = [],
    previews = [];
  let log = "",
    resets = 0;
  const createDocumentBuild = loadDocumentBuild({
    createBuildOperation() {
      const controller = new AbortController();
      const requested = deferred(),
        response = deferred();
      const operation = {
        id: `build-${operations.length}`,
        signal: controller.signal,
        requested,
        response,
        request(body) {
          requested.resolve(JSON.parse(body));
          return Promise.race([
            response.promise,
            new Promise((resolve, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })),
          ]);
        },
        cancel() {
          controller.abort(new DOMException("Build canceled", "AbortError"));
          return cancellation;
        },
      };
      operations.push(operation);
      return operation;
    },
  });
  const deps = {
    getRepo: () => state.repo,
    getSaving: () => Promise.resolve(),
    getReleaseForeground: () => null,
    getBuiltPdf: () => state.pdf,
    getSyncBuild: () => "previous-sync",
    getStatusVersion: () => state.version,
    getToastBuildOperation: () => state.operation,
    setToastBuildOperation: (value) => {
      state.operation = value;
    },
    getLimits: () => ({}),
    getLogText: () => log,
    saveDocument: async () => {},
    setEditorBusy() {},
    status(text, status) {
      state.version++;
      statuses.push({ text, state: status });
      cancel.hidden = status !== "busy" || !state.operation || state.operation.signal.aborted;
    },
    updateLog: (text) => {
      log = text;
    },
    selectLogs() {},
    preview: async (...args) => {
      previews.push(args);
      return true;
    },
    resetPreview: async () => {
      resets++;
    },
    updatePdfDownload() {},
    setBuiltPdf: (value) => {
      state.pdf = value;
    },
    publishingButton: button,
    cancelButton: cancel,
    fs: { promises: { readFile: async () => new Uint8Array([1]) } },
  };
  const factory = createDocumentBuild(deps);
  return {
    ...factory,
    state,
    deps,
    button,
    cancel,
    statuses,
    operations,
    previews,
    get resets() {
      return resets;
    },
  };
}
function finished(f) {
  assert.equal(f.button.disabled, false);
  assert.equal(f.cancel.hidden, true);
  assert.equal(f.cancel.onclick, null);
  assert.equal(f.state.operation, null);
}

test("directory duplicates are suppressed, controls stay busy, and completion permits rebuilding", async () => {
  const f = fixture();
  const building = f.buildDocument();
  await f.operations[0].requested.promise;
  assert.equal(f.button.disabled, true);
  assert.equal(f.cancel.hidden, false);
  assert.equal(f.isBuilding({ dir: "/workspace" }), true);
  const original = f.state.repo;
  f.state.repo = { ...original };
  assert.equal((await f.buildDocument()).statusHandled, true);
  assert.equal(f.operations.length, 1);
  f.state.repo = original;
  f.operations[0].response.resolve(success);
  assert.equal((await building).statusHandled, true);
  assert.equal(f.state.pdf.type, "application/pdf");
  finished(f);
  const again = f.buildDocument();
  await f.operations[1].requested.promise;
  f.operations[1].response.resolve(success);
  await again;
  finished(f);
});

for (const outcome of ["completion", "failure", "cancel"]) {
  test(`late ${outcome} preserves a newer foreground status`, async () => {
    const f = fixture();
    const building = f.buildDocument();
    await f.operations[0].requested.promise;
    if (outcome === "cancel") f.cancel.onclick();
    f.deps.status("Changes published.", "ready");
    const statuses = [...f.statuses];
    if (outcome === "failure") f.operations[0].response.reject(new Error("Failed"));
    else if (outcome === "completion") f.operations[0].response.resolve(success);
    await building;
    assert.deepEqual(f.statuses, statuses);
    finished(f);
  });
}

for (const latestFirst of [false, true]) {
  test(`overlapping builds retain control ownership (latest finishes first=${latestFirst})`, async () => {
    const f = fixture();
    const one = f.buildDocument();
    await f.operations[0].requested.promise;
    f.state.repo = { ...f.state.repo, dir: "/other" };
    const two = f.buildDocument();
    await f.operations[1].requested.promise;
    const latestCancel = f.cancel.onclick;
    if (latestFirst) {
      f.cancel.onclick();
      await two;
      assert.equal(f.button.disabled, true);
      assert.equal(f.cancel.onclick, null);
      f.operations[0].response.reject(new Error("Stale failure"));
      await one;
      assert.equal(f.statuses.at(-1).text, "Build canceled.");
    } else {
      const statuses = [...f.statuses];
      f.operations[0].response.reject(new Error("Stale failure"));
      await one;
      assert.deepEqual(f.statuses, statuses);
      assert.equal(f.button.disabled, true);
      assert.equal(f.cancel.onclick, latestCancel);
      assert.equal(f.state.operation, f.operations[1]);
      assert.deepEqual(f.previews, []);
      f.operations[1].response.resolve(success);
      await two;
    }
    finished(f);
  });
}

test("failure reports the error and releases publishing controls", async () => {
  const f = fixture();
  const building = f.buildDocument();
  await f.operations[0].requested.promise;
  f.operations[0].response.reject(new Error("Compilation failed"));
  await building;
  assert.deepEqual(f.statuses.at(-1), { text: "Build failed: Compilation failed", state: "error" });
  finished(f);
});

for (const transportFailure of [false, true]) {
  test(`cancel aborts immediately but retains controls until server confirmation (failure=${transportFailure})`, async () => {
    const cancellation = deferred();
    const f = fixture({ cancellation: cancellation.promise });
    const building = f.buildDocument();
    await f.operations[0].requested.promise;
    f.cancel.onclick();
    assert.equal(f.operations[0].signal.aborted, true);
    await setImmediate();
    assert.equal(f.button.disabled, true);
    if (transportFailure) cancellation.reject(new Error("Offline"));
    else cancellation.resolve();
    await building;
    assert.deepEqual(
      f.statuses.at(-1),
      transportFailure
        ? { text: "Build canceled locally. Server cancellation could not be confirmed.", state: "error" }
        : { text: "Build canceled.", state: "ready" },
    );
    finished(f);
  });
}

for (const previousPdf of [null, new Blob(["previous"])]) {
  test(`cancellation after preview commit restores the previous preview (PDF=${!!previousPdf})`, async () => {
    const f = fixture({ pdf: previousPdf });
    // Abort after the renderer commits, before compileDocument publishes its PDF.
    f.deps.preview = async (...args) => {
      f.previews.push(args);
      if (args[2]) f.cancel.onclick();
      return true;
    };
    const building = f.buildDocument();
    await f.operations[0].requested.promise;
    f.operations[0].response.resolve(success);
    await building;
    assert.equal(f.state.pdf, previousPdf);
    if (previousPdf) assert.deepEqual(f.previews[1], [previousPdf, "previous-sync"]);
    else assert.equal(f.resets, 1);
    finished(f);
  });
}
