// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { transform } from "esbuild";

const source = await readFile("src/application.ts", "utf8");
const start = source.indexOf("const backgroundActions =");
const end = source.indexOf("async function run(", start);
const { code } = await transform(source.slice(start, end), { loader: "ts" });

function fixture() {
  const statuses = [];
  const context = vm.createContext({
    status: (...args) => statuses.push(args),
    console: { error() {} },
  });
  vm.runInContext(code, context);
  return { run: context.runBackground, statuses };
}

test("background actions allow independent actions and suppress duplicate requests", async () => {
  const { run } = fixture();
  let finish;
  let calls = 0;
  const pending = run(() => new Promise((resolve) => { finish = resolve; }), "Refresh", "refresh");
  await run(() => { calls++; }, "Refresh", "refresh");
  assert.equal(calls, 0);
  await run(() => { calls++; }, "Download", "download");
  assert.equal(calls, 1);
  finish();
  await pending;
  await run(() => { calls++; }, "Refresh", "refresh");
  assert.equal(calls, 2);
});

test("background failures are reported and permit retry", async () => {
  const { run, statuses } = fixture();
  await run(() => { throw new Error("Offline"); }, "Refresh", "refresh");
  assert.deepEqual(statuses, [["Refresh failed: Offline", "error"]]);
  let retried = false;
  await run(() => { retried = true; }, "Refresh", "refresh");
  assert.equal(retried, true);
});

test("read-only toolbar actions use the non-blocking runner", () => {
  assert.match(source, /\["repositories", "refresh-branches", "copy-logs", "download-pdf"\]\.includes\(id\)\) return runBackground\(action, label, id\)/);
});
