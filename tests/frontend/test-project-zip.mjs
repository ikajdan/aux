// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { unzipSync } from "fflate";

const helper = await build({ entryPoints: ["src/ui/project-zip.ts"], bundle: true, write: false, format: "esm", platform: "browser" });
const { createProjectZip } = await import(`data:text/javascript;base64,${Buffer.from(helper.outputFiles[0].text).toString("base64")}`);
const worker = await build({ entryPoints: ["src/project-zip-worker.ts"], bundle: true, write: false, platform: "browser" });

function fixture(t, behavior) {
  const original = globalThis.Worker;
  t.after(() => { globalThis.Worker = original; });
  const workers = [];
  globalThis.Worker = class {
    constructor(url) {
      assert.equal(url, "/project-zip-worker.js");
      workers.push(this);
      const self = {
        postMessage: (data) => queueMicrotask(() => this.onmessage({ data })),
      };
      runInNewContext(worker.outputFiles[0].text, {
        self, Uint8Array, Uint16Array, Uint32Array, TextEncoder, TextDecoder,
        Worker: class { constructor() { throw new Error("Blob workers are blocked by CSP"); } },
      });
      this.send = (data) => self.onmessage({ data });
    }
    postMessage(entries) {
      if (behavior) behavior(this, entries);
      else this.send(entries);
    }
    terminate() { this.terminated = true; }
  };
  return workers;
}

test("project ZIP compresses large files without spawning CSP-blocked blob workers", async (t) => {
  const workers = fixture(t);
  const content = new Uint8Array(200_000).map((_, index) => index % 251);
  const entries = {
    "project/": new Uint8Array(),
    "project/empty/": new Uint8Array(),
    "project/main.tex": new TextEncoder().encode("\\documentclass{article}"),
    "project/images/large.png": content,
  };
  const bytes = await createProjectZip(entries);
  const restored = unzipSync(bytes);
  assert.deepEqual(Object.keys(restored).sort(), Object.keys(entries).sort());
  for (const path of Object.keys(entries)) assert.deepEqual(restored[path], entries[path]);
  assert.equal(workers[0].terminated, true);
});

test("worker compression failures reject instead of leaving the download pending", async (t) => {
  const workers = fixture(t, (worker) => worker.onmessage({ data: { error: "Compression failed" } }));
  await assert.rejects(createProjectZip({}), /Compression failed/);
  assert.equal(workers[0].terminated, true);
});

test("worker load errors reject and clean up", async (t) => {
  const workers = fixture(t, (worker) => worker.onerror({ message: "Worker blocked", preventDefault() {} }));
  await assert.rejects(createProjectZip({}), /Worker blocked/);
  assert.equal(workers[0].terminated, true);
});

test("unreadable worker messages reject and clean up", async (t) => {
  const workers = fixture(t, (worker) => worker.onmessageerror());
  await assert.rejects(createProjectZip({}), /Could not receive project ZIP/);
  assert.equal(workers[0].terminated, true);
});
