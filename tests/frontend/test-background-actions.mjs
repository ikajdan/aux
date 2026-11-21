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

function fixture() {
  const statuses = [];
  const context = vm.createContext({
    module: { exports: {} },
    status: (...args) => statuses.push(args),
    console: { error() {} },
  });
  vm.runInContext(code, context);
  const runner = context.module.exports.createOperationRunner({ status: context.status });
  return { run: runner.runBackground, statuses };
}

test("background actions allow independent actions and suppress duplicate requests", async () => {
  const { run } = fixture();
  let finish;
  let calls = 0;
  const pending = run(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    "Refresh",
    "refresh",
  );
  await run(
    () => {
      calls++;
    },
    "Refresh",
    "refresh",
  );
  assert.equal(calls, 0);
  await run(
    () => {
      calls++;
    },
    "Download",
    "download",
  );
  assert.equal(calls, 1);
  finish();
  await pending;
  await run(
    () => {
      calls++;
    },
    "Refresh",
    "refresh",
  );
  assert.equal(calls, 2);
});

test("background failures are reported and permit retry", async () => {
  const { run, statuses } = fixture();
  await run(
    async () => {
      throw new Error("Offline");
    },
    "Refresh",
    "refresh",
  );
  assert.deepEqual(statuses, [["Refresh failed: Offline", "error"]]);
  let retried = false;
  await run(
    () => {
      retried = true;
    },
    "Refresh",
    "refresh",
  );
  assert.equal(retried, true);
});
