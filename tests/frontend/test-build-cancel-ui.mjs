// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { transform } from "esbuild";

const source = await readFile("src/application.ts", "utf8");

const start = source.indexOf("async function preview(");
const end = source.indexOf("function goDocuments(", start);
assert.ok(start >= 0 && end > start);
const { code } = await transform(source.slice(start, end), { loader: "ts" });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const showing = deferred();
  const shown = [];
  const controls = [];
  const tabs = [];
  let resets = 0;
  let canceledSyncs = 0;
  const context = vm.createContext({
    syncGeneration: 0,
    syncBuild: "previous-build",
    syncError: "previous error",
    cancelSync: () => {
      canceledSyncs++;
    },
    updateSyncControls: () => {
      controls.push(context.syncBuild);
    },
    $: (id) => {
      assert.equal(id, "preview-tab");
      return id;
    },
    selectOutputTab: (tab) => {
      tabs.push(tab);
    },
    pdfPreview: {
      show: (blob, signal) => {
        shown.push({ blob, signal });
        return showing.promise;
      },
      reset: () => {
        resets++;
        return Promise.resolve();
      },
    },
  });
  vm.runInContext(code, context);
  return {
    context,
    showing,
    shown,
    controls,
    tabs,
    get resets() {
      return resets;
    },
    get canceledSyncs() {
      return canceledSyncs;
    },
    preview: (...args) => context.preview(...args),
  };
}

test("an already aborted preview leaves the current PDF and sync state untouched", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.preview(new Blob(), "new-build", controller.signal), (error) => error === controller.signal.reason);
  assert.deepEqual(f.shown, []);
  assert.deepEqual(f.controls, []);
  assert.deepEqual(f.tabs, []);
  assert.equal(f.resets, 0);
  assert.equal(f.canceledSyncs, 0);
  assert.equal(f.context.syncGeneration, 0);
  assert.equal(f.context.syncBuild, "previous-build");
  assert.equal(f.context.syncError, "previous error");
});

test("canceling a pending preview preserves the PDF and restores its prior SyncTeX", async () => {
  const f = fixture();
  const controller = new AbortController();
  const blob = new Blob(["new PDF"]);
  const rendering = f.preview(blob, "new-build", controller.signal);
  const rejected = assert.rejects(rendering, (error) => error === controller.signal.reason);
  assert.equal(f.shown.length, 1);
  assert.equal(f.shown[0].blob, blob);
  assert.equal(f.shown[0].signal, controller.signal, "PDF loading must receive the exact build cancellation signal");
  assert.equal(f.shown[0].signal.aborted, false);
  assert.deepEqual(f.tabs, ["preview-tab"]);
  assert.equal(f.context.syncError, "");
  assert.equal(f.context.syncBuild, null);
  controller.abort();
  assert.equal(f.shown[0].signal.aborted, true);
  assert.equal(f.resets, 0);
  assert.equal(f.canceledSyncs, 2);
  assert.equal(f.context.syncGeneration, 2);
  assert.equal(f.context.syncBuild, "previous-build");
  assert.deepEqual(f.controls, [null, "previous-build"]);
  f.showing.resolve();
  await rejected;
  assert.equal(f.resets, 0);
  assert.equal(f.context.syncBuild, "previous-build", "a late render completion must not publish canceled SyncTeX");
  assert.deepEqual(f.controls, [null, "previous-build"]);
});

test("a canceled PDF load rejection retains prior SyncTeX and the original abort reason", async () => {
  const f = fixture();
  const controller = new AbortController();
  const reason = new DOMException("Build canceled", "AbortError");
  const rendering = f.preview(new Blob(), "new-build", controller.signal);
  assert.equal(f.shown[0].signal, controller.signal);
  const rejected = assert.rejects(rendering, (error) => error === reason);
  controller.abort(reason);
  f.showing.reject(controller.signal.reason);
  await rejected;
  assert.equal(f.context.syncBuild, "previous-build");
  assert.equal(f.resets, 0);
  assert.deepEqual(f.controls, [null, "previous-build"]);
});

test("a completed preview publishes SyncTeX and removes its abort listener", async () => {
  const f = fixture();
  const controller = new AbortController();
  const rendering = f.preview(new Blob(), "new-build", controller.signal);
  assert.equal(f.shown[0].signal, controller.signal);
  f.showing.resolve();
  await rendering;
  assert.equal(f.context.syncBuild, "new-build");
  assert.deepEqual(f.controls, [null, "new-build"]);
  controller.abort();
  assert.equal(f.resets, 0);
  assert.equal(f.canceledSyncs, 1);
  assert.equal(f.context.syncBuild, "new-build");
});

test("canceling an obsolete preview does not reset or clear a newer generation", async () => {
  const f = fixture();
  const controller = new AbortController();
  const rendering = f.preview(new Blob(), "obsolete-build", controller.signal);
  const rejected = assert.rejects(rendering, (error) => error === controller.signal.reason);
  f.context.syncGeneration++;
  f.context.syncBuild = "newer-build";
  controller.abort();
  f.showing.resolve();
  await rejected;
  assert.equal(f.resets, 0);
  assert.equal(f.canceledSyncs, 1);
  assert.equal(f.context.syncBuild, "newer-build");
});

test("a failed obsolete preview cannot restore SyncTeX over a newer generation", async () => {
  const f = fixture();
  const controller = new AbortController();
  const rendering = f.preview(new Blob(), "obsolete-build", controller.signal);
  const error = new Error("Obsolete PDF failed");
  const rejected = assert.rejects(rendering, (failure) => failure === error);
  f.context.syncGeneration++;
  f.context.syncBuild = "newer-build";
  f.showing.reject(error);
  await rejected;
  controller.abort();
  assert.equal(f.context.syncBuild, "newer-build");
  assert.equal(f.resets, 0);
  assert.equal(f.canceledSyncs, 1);
  assert.deepEqual(f.controls, [null]);
});

test("a failed preview restores prior SyncTeX and removes its abort listener", async () => {
  const f = fixture();
  const controller = new AbortController();
  const error = new Error("PDF rendering failed");
  const rendering = f.preview(new Blob(), "new-build", controller.signal);
  const rejected = assert.rejects(rendering, (failure) => failure === error);
  f.showing.reject(error);
  await rejected;
  controller.abort();
  assert.equal(f.context.syncBuild, "previous-build");
  assert.equal(f.resets, 0);
  assert.equal(f.canceledSyncs, 1);
  assert.deepEqual(f.controls, [null, "previous-build"]);
});
