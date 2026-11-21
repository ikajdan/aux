// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/workspace/source-pdf.ts"], bundle: true, write: false,
  platform: "node", format: "iife", globalName: "sourcePdfModule",
});
const code = outputFiles[0].text;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture() {
  const showing = deferred();
  const shown = [], controls = [], tabs = [];
  let resets = 0, canceledSyncs = 0, initialized = false;
  const context = vm.createContext({
    AbortController, setTimeout,
    clearTimeout: (timer) => { canceledSyncs++; clearTimeout(timer); },
  });
  vm.runInContext(code, context);
  const controller = context.sourcePdfModule.createSourcePdf({
    editor: {},
    pdfPreview: {
      show: (blob, signal) => {
        if (!initialized) return Promise.resolve();
        shown.push({ blob, signal });
        return showing.promise;
      },
      reset: () => { resets++; return Promise.resolve(); },
      setSyncEnabled: () => { if (initialized) controls.push(controller.build); },
    },
    syncButton: { setAttribute() {} },
    isBusy: () => false,
    areBusyControlsShown: () => false,
    selectPreview: () => { if (initialized) tabs.push("preview-tab"); },
  });
  await controller.preview(new Blob(), "previous-build");
  initialized = true;
  canceledSyncs = 0;
  return {
    controller, showing, shown, controls, tabs,
    get resets() { return resets; },
    get canceledSyncs() { return canceledSyncs; },
    preview: (...args) => controller.preview(...args),
    async newer() {
      initialized = false;
      await controller.preview(new Blob(), "newer-build");
      initialized = true;
      canceledSyncs--;
    },
  };
}

test("an already aborted preview leaves the current PDF and sync state untouched", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.preview(new Blob(), "new-build", controller.signal), (error) => error === controller.signal.reason);
  assert.deepEqual(f.shown, []);
  assert.deepEqual(f.controls, []);
  assert.deepEqual(f.tabs, []);
  assert.equal(f.resets, 0);
  assert.equal(f.canceledSyncs, 0);
  assert.equal(f.controller.build, "previous-build");
});

test("canceling a pending preview preserves the PDF and restores its prior SyncTeX", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const blob = new Blob(["new PDF"]);
  const rendering = f.preview(blob, "new-build", controller.signal);
  const rejected = assert.rejects(rendering, (error) => error === controller.signal.reason);
  assert.equal(f.shown.length, 1);
  assert.equal(f.shown[0].blob, blob);
  assert.equal(f.shown[0].signal, controller.signal, "PDF loading must receive the exact build cancellation signal");
  assert.equal(f.shown[0].signal.aborted, false);
  assert.deepEqual(f.tabs, ["preview-tab"]);
  assert.equal(f.controller.build, null);
  controller.abort();
  assert.equal(f.shown[0].signal.aborted, true);
  assert.equal(f.resets, 0);
  assert.equal(f.canceledSyncs, 2);
  assert.equal(f.controller.build, "previous-build");
  assert.deepEqual(f.controls, [null, "previous-build"]);
  f.showing.resolve();
  await rejected;
  assert.equal(f.resets, 0);
  assert.equal(f.controller.build, "previous-build", "a late render completion must not publish canceled SyncTeX");
  assert.deepEqual(f.controls, [null, "previous-build"]);
});

test("a canceled PDF load rejection retains prior SyncTeX and the original abort reason", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const reason = new DOMException("Build canceled", "AbortError");
  const rendering = f.preview(new Blob(), "new-build", controller.signal);
  assert.equal(f.shown[0].signal, controller.signal);
  const rejected = assert.rejects(rendering, (error) => error === reason);
  controller.abort(reason);
  f.showing.reject(controller.signal.reason);
  await rejected;
  assert.equal(f.controller.build, "previous-build");
  assert.equal(f.resets, 0);
  assert.deepEqual(f.controls, [null, "previous-build"]);
});

test("a completed preview publishes SyncTeX and removes its abort listener", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const rendering = f.preview(new Blob(), "new-build", controller.signal);
  assert.equal(f.shown[0].signal, controller.signal);
  f.showing.resolve();
  await rendering;
  assert.equal(f.controller.build, "new-build");
  assert.deepEqual(f.controls, [null, "new-build"]);
  controller.abort();
  assert.equal(f.resets, 0);
  assert.equal(f.canceledSyncs, 1);
  assert.equal(f.controller.build, "new-build");
});

test("canceling an obsolete preview does not reset or clear a newer generation", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const rendering = f.preview(new Blob(), "obsolete-build", controller.signal);
  const rejected = assert.rejects(rendering, (error) => error === controller.signal.reason);
  await f.newer();
  controller.abort();
  f.showing.resolve();
  await rejected;
  assert.equal(f.resets, 0);
  assert.equal(f.canceledSyncs, 1);
  assert.equal(f.controller.build, "newer-build");
});

test("a failed obsolete preview cannot restore SyncTeX over a newer generation", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const rendering = f.preview(new Blob(), "obsolete-build", controller.signal);
  const error = new Error("Obsolete PDF failed");
  const rejected = assert.rejects(rendering, (failure) => failure === error);
  await f.newer();
  f.showing.reject(error);
  await rejected;
  controller.abort();
  assert.equal(f.controller.build, "newer-build");
  assert.equal(f.resets, 0);
  assert.equal(f.canceledSyncs, 1);
  assert.deepEqual(f.controls, [null]);
});

test("a failed preview restores prior SyncTeX and removes its abort listener", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const error = new Error("PDF rendering failed");
  const rendering = f.preview(new Blob(), "new-build", controller.signal);
  const rejected = assert.rejects(rendering, (failure) => failure === error);
  f.showing.reject(error);
  await rejected;
  controller.abort();
  assert.equal(f.controller.build, "previous-build");
  assert.equal(f.resets, 0);
  assert.equal(f.canceledSyncs, 1);
  assert.deepEqual(f.controls, [null, "previous-build"]);
});
