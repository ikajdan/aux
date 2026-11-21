// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/ui/status.ts"], bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{
    name: "status-icons",
    setup(builder) {
      builder.onResolve({ filter: /ui-icons\.js$/ }, () => ({ path: "icons", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const icon = () => ({});" }));
    },
  }],
});

function fixture() {
  const timers = [];
  const content = {
    dataset: {}, children: [],
    replaceChildren(...children) { this.children = children; },
    get lastChild() { return this.children.at(-1); },
    get text() { return this.children.map((child) => child.textContent || "").join(""); },
  };
  const toast = {
    hidden: true, open: false,
    matches() { return this.open; },
    showPopover() { assert.equal(this.open, false); this.open = true; },
    hidePopover() { assert.equal(this.open, true); this.open = false; },
  };
  const cancelBuild = { hidden: true };
  const state = { busy: false, operation: null };
  const context = vm.createContext({
    module: { exports: {} }, Node: { TEXT_NODE: 3 },
    document: { createTextNode: (textContent) => ({ nodeType: 3, textContent }) },
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  const controller = context.module.exports.createStatusController({
    content, toast, cancelBuild,
    isBusy: () => state.busy,
    getBuildOperation: () => state.operation,
  });
  return { ...controller, controller, content, toast, cancelBuild, timers, state };
}

test("an old dismissal callback cannot hide a newer operation's progress", () => {
  const f = fixture();
  f.status("Saved", "ready");
  const oldTimer = f.timers[0];
  assert.equal(oldTimer.delay, 5000);
  f.state.busy = true;
  f.status("Compiling");
  const version = f.controller.version;
  // Simulate a callback already queued when its timer was canceled.
  oldTimer.callback();
  assert.equal(oldTimer.cleared, true);
  assert.equal(f.controller.version, version);
  assert.equal(f.content.text, "Compiling…");
  assert.equal(f.toast.hidden, false);
  assert.equal(f.toast.open, true);
});

test("status formatting and same-state replacement preserve readable messages", () => {
  const f = fixture();
  for (const [message, state, expected] of [
    ["Preparing", "busy", "Preparing…"],
    ["Compiling…", "busy", "Compiling…"],
    ["Saved!  ", "ready", "Saved!"],
    ["Build failed", "error", "Build failed."],
  ]) {
    f.status(message, state);
    assert.equal(f.content.text, expected);
    assert.equal(f.content.dataset.state, state);
  }
  assert.equal(f.timers.at(-1).delay, 8000);
  f.timers.at(-1).callback();
  assert.equal(f.toast.hidden, true);
  assert.equal(f.toast.open, false);
  assert.equal(f.content.text, "");
});

test("cancel is exposed only for an active un-aborted build with busy status", () => {
  const f = fixture();
  f.status("Loading", "busy");
  assert.equal(f.cancelBuild.hidden, true);
  f.state.operation = { signal: { aborted: false } };
  f.status("Building", "busy");
  assert.equal(f.cancelBuild.hidden, false);
  f.state.operation.signal.aborted = true;
  f.status("Canceling", "busy");
  assert.equal(f.cancelBuild.hidden, true);
  f.state.operation.signal.aborted = false;
  f.status("Finished", "ready");
  assert.equal(f.cancelBuild.hidden, true);
});

test("empty status dismisses safely and invalidates any pending dismissal", () => {
  const f = fixture();
  f.status("Saved", "ready");
  const previousVersion = f.controller.version;
  f.status("   ");
  assert.ok(f.controller.version > previousVersion);
  assert.equal(f.content.text, "");
  assert.equal(f.toast.hidden, true);
  assert.equal(f.cancelBuild.hidden, true);
  assert.equal(f.timers[0].cleared, true);
  const dismissedVersion = f.controller.version;
  f.timers[0].callback();
  assert.equal(f.controller.version, dismissedVersion);
  f.dismissStatus();
  assert.equal(f.toast.open, false);
});
