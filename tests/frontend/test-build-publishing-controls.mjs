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
function fixture(compileDocument, { cancellation = Promise.resolve(), pdf = null, synctex = null } = {}) {
  const button = { disabled: false };
  const cancelButton = { hidden: true, onclick: null };
  const statuses = [];
  const operations = [];
  const previews = [];
  let resets = 0;
  const context = vm.createContext({
    $: (id) => {
      assert.ok(id === "publishing" || id === "cancel-build");
      return id === "publishing" ? button : cancelButton;
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
    repo: {},
    builtPdf: pdf,
    syncBuild: synctex,
    toastBuildOperation: null,
    status: (text, state) => {
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
function assertCancellationHandled(result) {
  assert.equal(result?.statusHandled, true, "cancellation must suppress the caller's generic success status");
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
  assert.equal(await building, undefined);
  assertFinished(f);
});

test("failed or canceled builds re-enable Publish changes", async () => {
  const error = new Error("Compilation failed");
  const f = fixture(async () => {
    throw error;
  });
  await assert.rejects(f.build(), (failure) => failure === error);
  assertFinished(f);
  assert.equal(f.operations[0].signal.aborted, false);
  const canceled = fixture(async () => false);
  assert.equal(await canceled.build(), false);
  assertFinished(canceled);
});

test("overlapping builds do not re-enable publishing until both have finished", async () => {
  const first = deferred();
  const second = deferred();
  const queue = [first, second];
  const f = fixture(() => queue.shift().promise);
  const one = f.build();
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
  f.context.repo = {};
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
