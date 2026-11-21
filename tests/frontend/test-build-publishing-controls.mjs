// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";
import { transform } from "esbuild";

const source = await readFile("src/application.ts", "utf8");
const start = source.indexOf("let activePdfBuilds =");
const end = source.indexOf("async function compileDocument(", start);
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
let repositorySequence = 0;
function repository() {
  return { dir: `/workspace-${++repositorySequence}` };
}
function fixture(compileDocument, { cancellation = Promise.resolve(), pdf = null, synctex = null } = {}) {
  const button = { disabled: false };
  const cancelButton = { hidden: true, onclick: null };
  const log = { textContent: "" };
  const logsTab = {};
  const selectedTabs = [];
  let downloadUpdates = 0;
  const statuses = [];
  const operations = [];
  const previews = [];
  let resets = 0;
  const context = vm.createContext({
    $: (id) => {
      const elements = { publishing: button, "cancel-build": cancelButton, log, "logs-tab": logsTab };
      assert.ok(Object.hasOwn(elements, id));
      return elements[id];
    },
    createBuildOperation: () => {
      const controller = new AbortController();
      let canceled;
      const operation = {
        signal: controller.signal,
        cancelCalls: 0,
        cancel() {
          operation.cancelCalls++;
          if (!canceled) {
            canceled = cancellation;
            controller.abort(new DOMException("Build canceled", "AbortError"));
          }
          return canceled;
        },
      };
      operations.push(operation);
      return operation;
    },
    releaseForeground: null,
    updatePdfDownload: () => {
      downloadUpdates++;
    },
    updateLog: (text) => {
      log.textContent = text;
    },
    selectOutputTab: (tab) => selectedTabs.push(tab),
    repo: repository(),
    builtPdf: pdf,
    syncBuild: synctex,
    toastBuildOperation: null,
    statusVersion: 0,
    status: (text, state) => {
      context.statusVersion++;
      statuses.push({ text, state });
      cancelButton.hidden = state !== "busy" || !context.toastBuildOperation || context.toastBuildOperation.signal.aborted;
    },
    preview: async (...args) => {
      previews.push(args);
    },
    pdfPreview: {
      reset: async () => {
        resets++;
      },
    },
    compileDocument,
  });
  vm.runInContext(code, context);
  return {
    button,
    cancelButton,
    statuses,
    log,
    logsTab,
    selectedTabs,
    get downloadUpdates() {
      return downloadUpdates;
    },
    operations,
    previews,
    context,
    get resets() {
      return resets;
    },
    build: () => context.buildDocument(),
  };
}
function pendingCompile(operation) {
  return new Promise((resolve, reject) => {
    operation.signal.addEventListener("abort", () => reject(operation.signal.reason), { once: true });
  });
}
function assertFinished(f) {
  assert.equal(f.button.disabled, false);
  assert.equal(f.cancelButton.hidden, true);
  assert.equal(f.cancelButton.onclick, null);
  assert.equal(f.context.toastBuildOperation, null);
}
function assertStatusHandled(result) {
  assert.equal(result?.statusHandled, true, "the build must suppress the caller's generic status");
}
const assertCancellationHandled = assertStatusHandled;

test("duplicate builds in the same repository are suppressed until the build finishes", async () => {
  const compile = deferred();
  const f = fixture(() => compile.promise);
  const building = f.build();
  const cancel = f.cancelButton.onclick;
  const statuses = [...f.statuses];
  assertStatusHandled(await f.build());
  assert.equal(f.operations.length, 1);
  assert.equal(f.button.disabled, true);
  assert.equal(f.cancelButton.onclick, cancel);
  assert.deepEqual(f.statuses, statuses);
  assert.equal(f.downloadUpdates, 0);
  compile.resolve();
  assertStatusHandled(await building);
  assertFinished(f);
  assertStatusHandled(await f.build());
  assert.equal(f.operations.length, 2, "completion must allow another build in the same repository");
  assert.equal(f.downloadUpdates, 2);
  assertFinished(f);
});

test("reactivating the same directory suppresses duplicate builds across repository objects", async () => {
  const compile = deferred();
  const f = fixture(() => compile.promise);
  const originalRepository = f.context.repo;
  const building = f.build();
  f.context.repo = { dir: originalRepository.dir };
  assert.notEqual(f.context.repo, originalRepository);
  const statuses = [...f.statuses];
  assertStatusHandled(await f.build());
  assert.equal(f.operations.length, 1);
  assert.deepEqual(f.statuses, statuses);
  assert.equal(f.button.disabled, true);
  assert.equal(f.downloadUpdates, 0);
  compile.resolve();
  assertStatusHandled(await building);
  assert.deepEqual(f.statuses, statuses, "the original repository object no longer owns the status");
  assertFinished(f);
  assertStatusHandled(await f.build());
  assert.equal(f.operations.length, 2, "finishing must release the directory key");
  assertFinished(f);
});

for (const outcome of ["completion", "failure", "cancel"]) {
  test(`late build progress and ${outcome} preserve a newer foreground status`, async () => {
    const compile = deferred();
    let report;
    const f = fixture((operation, onPreviewCommit, onSnapshot, current, reportStatus) => {
      report = reportStatus;
      return compile.promise;
    });
    const building = f.build();
    report("Compiling document…", "busy");
    assert.deepEqual(f.statuses.at(-1), { text: "Compiling document…", state: "busy" });
    if (outcome === "cancel") f.cancelButton.onclick();
    f.context.status("Changes published.", "ready");
    const statuses = [...f.statuses];
    const version = f.context.statusVersion;
    report("Rendering document…", "busy");
    assert.deepEqual(f.statuses, statuses);
    assert.equal(f.context.statusVersion, version);
    if (outcome === "completion") compile.resolve();
    else compile.reject(outcome === "cancel" ? f.operations[0].signal.reason : new Error("Compilation failed"));
    assertStatusHandled(await building);
    assert.deepEqual(f.statuses, statuses);
    assert.equal(f.context.statusVersion, version);
    assert.equal(f.downloadUpdates, 1);
    assertFinished(f);
  });
}

test("build passes the captured foreground release and repository-aware ownership callback", async () => {
  const compile = deferred();
  let snapshot, current;
  const f = fixture((operation, onPreviewCommit, onSnapshot, isCurrent) => {
    snapshot = onSnapshot;
    current = isCurrent;
    return compile.promise;
  });
  const release = async () => {};
  f.context.releaseForeground = release;
  const originalRepository = f.context.repo;
  const building = f.build();
  assert.equal(snapshot, release);
  assert.equal(current(), true);
  f.context.repo = repository();
  assert.equal(current(), false);
  f.context.repo = originalRepository;
  assert.equal(current(), true);
  compile.resolve();
  assertStatusHandled(await building);
  assertFinished(f);
});

for (const outcome of ["failure", "cancel"]) {
  test(`stale build ${outcome} does not overwrite the latest build status or preview`, async () => {
    const first = deferred();
    const second = deferred();
    let calls = 0;
    const f = fixture(
      (operation, onPreviewCommit) => {
        if (++calls === 1) {
          onPreviewCommit();
          return first.promise;
        }
        return second.promise;
      },
      { pdf: new Blob(["previous PDF"]), synctex: "previous-build" },
    );
    const one = f.build();
    const oldCurrent = f.cancelButton.onclick;
    if (outcome === "cancel") oldCurrent();
    f.context.repo = repository();
    const two = f.build();
    const cancelLatest = f.cancelButton.onclick;
    const statuses = [...f.statuses];
    first.reject(outcome === "cancel" ? f.operations[0].signal.reason : new Error("Stale compilation failed"));
    assertStatusHandled(await one);
    assert.deepEqual(f.statuses, statuses);
    assert.equal(f.log.textContent, "");
    assert.deepEqual(f.selectedTabs, []);
    assert.deepEqual(f.previews, []);
    assert.equal(f.resets, 0);
    assert.equal(f.cancelButton.onclick, cancelLatest);
    assert.equal(f.context.toastBuildOperation, f.operations[1]);
    assert.equal(f.button.disabled, true);
    assert.equal(f.downloadUpdates, 1);
    second.resolve();
    assertStatusHandled(await two);
    assert.deepEqual(f.statuses.at(-1), { text: "Build complete.", state: "ready" });
    assert.equal(f.downloadUpdates, 2);
    assertFinished(f);
  });
}

test("Publish changes stays disabled throughout the PDF build and re-enables on completion", async () => {
  const compile = deferred();
  const f = fixture(() => compile.promise);
  const building = f.build();
  assert.equal(f.button.disabled, true);
  assert.equal(f.cancelButton.hidden, false);
  assert.equal(typeof f.cancelButton.onclick, "function");
  assert.equal(f.context.toastBuildOperation, f.operations[0]);
  assert.deepEqual(f.statuses, [{ text: "Preparing document…", state: "busy" }]);
  compile.resolve();
  assertStatusHandled(await building);
  assert.deepEqual(f.statuses.at(-1), { text: "Build complete.", state: "ready" });
  assert.equal(f.downloadUpdates, 1);
  assertFinished(f);
});

test("failed or canceled builds re-enable Publish changes", async () => {
  const error = new Error("Compilation failed");
  const f = fixture(async () => {
    throw error;
  });
  assertStatusHandled(await f.build());
  assert.deepEqual(f.statuses.at(-1), { text: "Build failed: Compilation failed", state: "error" });
  assert.equal(f.log.textContent, error.message);
  assert.deepEqual(f.selectedTabs, [f.logsTab]);
  assert.equal(f.downloadUpdates, 1);
  assertFinished(f);
  assert.equal(f.operations[0].signal.aborted, false);
  const canceled = fixture(async () => false);
  assertStatusHandled(await canceled.build());
  assert.deepEqual(canceled.statuses.at(-1), { text: "Build complete.", state: "ready" });
  assertFinished(canceled);
});

test("overlapping builds do not re-enable publishing until both have finished", async () => {
  const first = deferred();
  const second = deferred();
  const queue = [first, second];
  const f = fixture(() => queue.shift().promise);
  const one = f.build();
  f.context.repo = repository();
  const two = f.build();
  const cancelLatest = f.cancelButton.onclick;
  first.resolve();
  await one;
  assert.equal(f.button.disabled, true);
  assert.equal(f.cancelButton.hidden, false);
  assert.equal(f.cancelButton.onclick, cancelLatest);
  assert.equal(f.context.toastBuildOperation, f.operations[1]);
  second.resolve();
  await two;
  assertFinished(f);
});

test("cancel aborts a pending compile immediately and waits for server cancellation before finishing", async () => {
  const cancellation = deferred();
  const f = fixture(pendingCompile, { cancellation: cancellation.promise });
  const building = f.build();
  let finished = false;
  void building.then(() => {
    finished = true;
  });
  f.cancelButton.onclick();
  assert.equal(f.operations[0].signal.aborted, true);
  assert.equal(f.cancelButton.hidden, true);
  assert.deepEqual(f.statuses.at(-1), { text: "Canceling build…", state: "busy" });
  await setImmediate();
  assert.equal(f.operations[0].cancelCalls, 2, "the wrapper must await the cancellation started by the button");
  assert.equal(finished, false);
  assert.equal(f.button.disabled, true);
  cancellation.resolve();
  assertCancellationHandled(await building);
  assert.deepEqual(f.statuses.at(-1), { text: "Build canceled.", state: "ready" });
  assert.deepEqual(f.previews, []);
  assert.equal(f.resets, 0);
  assertFinished(f);
});

test("cancellation transport failure reports an error rather than success and releases controls", async () => {
  const cancellation = deferred();
  const f = fixture(pendingCompile, { cancellation: cancellation.promise });
  const building = f.build();
  f.cancelButton.onclick();
  cancellation.reject(new TypeError("Network unavailable"));
  assertCancellationHandled(await building);
  assert.deepEqual(f.statuses.at(-1), {
    text: "Build canceled locally. Server cancellation could not be confirmed.",
    state: "error",
  });
  assert.equal(
    f.statuses.some(({ state }) => state === "ready"),
    false,
  );
  assertFinished(f);
});

test("canceling rendering restores the previous PDF and SyncTeX captured before compilation", async () => {
  const pdf = new Blob(["previous PDF"]);
  const f = fixture(
    (operation, onPreviewStart) => {
      onPreviewStart();
      f.context.builtPdf = new Blob(["unfinished PDF"]);
      f.context.syncBuild = null;
      return pendingCompile(operation);
    },
    { pdf, synctex: "previous-build" },
  );
  const building = f.build();
  f.cancelButton.onclick();
  assertCancellationHandled(await building);
  assert.equal(f.previews.length, 1);
  assert.equal(f.previews[0][0], pdf);
  assert.equal(f.previews[0][1], "previous-build");
  assert.equal(f.previews[0].length, 2, "restoration must not reuse the aborted signal");
  assert.equal(f.resets, 0);
  assertFinished(f);
});

test("canceling rendering without a previous PDF resets the preview", async () => {
  const f = fixture((operation, onPreviewStart) => {
    onPreviewStart();
    return pendingCompile(operation);
  });
  const building = f.build();
  f.cancelButton.onclick();
  assertCancellationHandled(await building);
  assert.deepEqual(f.previews, []);
  assert.equal(f.resets, 1);
  assertFinished(f);
});

test("canceling rendering does not restore a preview into a different repository", async () => {
  const f = fixture(
    (operation, onPreviewStart) => {
      onPreviewStart();
      return pendingCompile(operation);
    },
    { pdf: new Blob(["previous PDF"]), synctex: "previous-build" },
  );
  const building = f.build();
  f.context.repo = repository();
  f.cancelButton.onclick();
  assertCancellationHandled(await building);
  assert.deepEqual(f.previews, []);
  assert.equal(f.resets, 0);
  assertFinished(f);
});

test("canceling the latest overlapping build keeps publishing disabled until the older build finishes", async () => {
  const first = deferred();
  let calls = 0;
  const f = fixture((operation) => (++calls === 1 ? first.promise : pendingCompile(operation)));
  const one = f.build();
  f.context.repo = repository();
  const two = f.build();
  f.cancelButton.onclick();
  assert.equal(f.operations[0].signal.aborted, false);
  assert.equal(f.operations[1].signal.aborted, true);
  assertCancellationHandled(await two);
  assert.equal(f.button.disabled, true);
  assert.equal(f.cancelButton.hidden, true);
  assert.equal(f.cancelButton.onclick, null);
  first.resolve();
  await one;
  assertFinished(f);
});
