// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/ui/operations.ts"], bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{ name: "dom-dependencies", setup(build) {
    build.onLoad({ filter: /application-elements\.ts$/ }, () => ({ contents: "export const $ = (...args) => globalThis.queryElement(...args);", loader: "js" }));
    build.onLoad({ filter: /modal-dialogs\.ts$/ }, () => ({ contents: "export const restoreFocus = (...args) => globalThis.restorePreviousFocus(...args);", loader: "js" }));
  } }],
});
const code = outputFiles[0].text;

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function fixture() {
  const calls = { navigation: 0, focus: 0, warnings: 0, flush: 0 };
  const editorBusy = [];
  const statuses = [];
  const errors = [];
  const control = (id, disabled = false) => ({ id, disabled, closest: () => null });
  const controls = [control("save"), control("unavailable", true), control("compile"), control("download-pdf")];
  const attributes = new Map();
  const elements = Object.fromEntries(controls.map((c) => [c.id, c]));
  elements.workspace = { setAttribute: (name, value) => attributes.set(name, value) };
  elements["project-search-panel"] = { contains: () => false };
  const previousFocus = {};
  let locked = false;
  const context = vm.createContext({
    module: { exports: {} },
    repo: { dir: "/workspace/project" },
    meta: {},
    builtPdf: {},
    buildingRepositories: new Set(),
    isBuilding: (repo) => context.buildingRepositories.has(repo?.dir),
    documents: { saving: Promise.resolve() },
    workspaceWarnings: new Map(),
    fs: {
      promises: {
        flush: async () => {
          calls.flush++;
        },
      },
    },
    document: { activeElement: previousFocus, querySelectorAll: () => controls },
    queryElement: (id) => {
      assert.ok(Object.hasOwn(elements, id), `Unexpected element: ${id}`);
      return elements[id];
    },
    editor: {
      setBusy: (value) => {
        locked = value;
        editorBusy.push(value);
      },
      hasFocus: () => false,
    },
    closeTreeMenu() {},
    branchSelect: { close() {}, sync() {} },
    targetBranchSelect: { close() {}, sync() {} },
    operationProgress: (label) => label,
    status: (...args) => statuses.push(args),
    dismissStatus() {},
    refreshWarning: async () => {
      calls.warnings++;
    },
    restorePreviousFocus: (element) => {
      assert.equal(element, previousFocus);
      calls.focus++;
    },
    processNavigation: async () => {
      calls.navigation++;
    },
    updateMergeRequestControls() {},
    updateSyncControls() {},
    syncTree() {},
    updateFilenameSaveState() {},
    console: { error: (error) => errors.push(error) },
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(code, context);
  const runner = context.module.exports.createOperationRunner({
    ...context,
    getSaving: () => context.documents.saving,
    getWorkspace: () => ({ repo: context.repo, meta: context.meta }),
    updatePdfDownload: () => context.updatePdfDownload(),
  });
  context.updatePdfDownload = () => {
    elements["download-pdf"].disabled = runner.controlsShown || !context.builtPdf;
    elements.compile.disabled = runner.controlsShown || context.isBuilding(context.repo);
    context.updateSyncControls();
  };
  context.run = runner.run;
  Object.defineProperties(context, {
    busy: { get: () => runner.busy },
    busyControlsShown: { get: () => runner.controlsShown },
    releaseForeground: { get: () => runner.releaseForeground },
  });
  return {
    context,
    calls,
    controls,
    attributes,
    editorBusy,
    statuses,
    errors,
    get locked() {
      return locked;
    },
  };
}

function assertForeground(f, busy) {
  assert.equal(f.context.busy, busy);
  assert.equal(f.context.busyControlsShown, busy);
  assert.equal(f.locked, busy);
  assert.equal(f.attributes.get("aria-busy"), String(busy));
  assert.equal(f.controls[0].disabled, busy);
  assert.equal(f.controls[1].disabled, true, "originally disabled controls must stay disabled");
}

test("snapshot release unlocks navigation while the action waits, and stale completion cannot clean up a newer run", async () => {
  const f = fixture();
  const firstRequest = deferred();
  const released = deferred();
  let capturedRelease;
  let firstFinished = false;
  const first = f.context.run(async () => {
    capturedRelease = f.context.releaseForeground;
    await capturedRelease();
    released.resolve();
    await firstRequest.promise;
  }, "Build");
  void first.then(() => {
    firstFinished = true;
  });
  assertForeground(f, true);
  await released.promise;
  assert.equal(typeof capturedRelease, "function");
  assert.equal(firstFinished, false, "the build request is still pending after snapshot release");
  assertForeground(f, false);
  assert.equal(f.controls[2].disabled, false);
  assert.equal(f.controls[3].disabled, false);
  assert.equal(f.context.releaseForeground, null);
  assert.deepEqual(f.calls, { navigation: 1, focus: 1, warnings: 1, flush: 1 });

  const secondRequest = deferred();
  const secondStarted = deferred();
  const second = f.context.run(async () => {
    secondStarted.resolve();
    await secondRequest.promise;
  }, "Navigate");
  await secondStarted.promise;
  assertForeground(f, true);
  const secondRelease = f.context.releaseForeground;
  assert.notEqual(secondRelease, capturedRelease);
  const callsBefore = { ...f.calls };
  const editorBefore = [...f.editorBusy];
  const statusesBefore = [...f.statuses];
  firstRequest.resolve();
  await first;
  assertForeground(f, true);
  assert.ok(f.controls.every((control) => control.disabled));
  assert.equal(f.context.releaseForeground, secondRelease);
  assert.deepEqual(f.calls, callsBefore, "old completion must not flush, refresh warnings, restore focus, or process navigation");
  assert.deepEqual(f.editorBusy, editorBefore);
  assert.deepEqual(f.statuses, statusesBefore, "old completion must not replace the newer operation status");

  secondRequest.resolve();
  await second;
  assertForeground(f, false);
  assert.equal(f.context.releaseForeground, null);
  assert.equal(f.controls[2].disabled, false);
  assert.equal(f.controls[3].disabled, false);
  assert.deepEqual(f.calls, { navigation: 2, focus: 2, warnings: 2, flush: 2 });
  assert.deepEqual(f.statuses.at(-1), ["Navigate complete.", "ready"]);
  assert.deepEqual(f.errors, []);
});

test("injected PDF control refresh keeps compile disabled after foreground release until the repository build ends", async () => {
  const f = fixture();
  const request = deferred();
  const released = deferred();
  const originalRepo = f.context.repo;
  f.context.buildingRepositories.add(originalRepo.dir);
  const building = f.context.run(async () => {
    const release = f.context.releaseForeground;
    await release();
    released.resolve();
    await request.promise;
  }, "Build");
  assertForeground(f, true);
  await released.promise;
  assertForeground(f, false);
  assert.equal(f.controls[2].disabled, true, "foreground cleanup must not enable a duplicate build");
  assert.equal(f.controls[3].disabled, false, "an existing PDF remains downloadable");
  f.context.repo = { dir: originalRepo.dir };
  assert.notEqual(f.context.repo, originalRepo);
  f.context.updatePdfDownload();
  assert.equal(f.controls[2].disabled, true, "a new Repository object for the same directory must remain compile-disabled");
  request.resolve();
  await building;
  assert.equal(f.controls[2].disabled, true, "run completion does not remove the repository's build ownership");
  f.context.buildingRepositories.delete(originalRepo.dir);
  f.context.updatePdfDownload();
  assert.equal(f.controls[2].disabled, false);
  assert.deepEqual(f.errors, []);
});
