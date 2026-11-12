// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

// Supply only rendering, modal lookup and event primitives; run the real shortcuts.
class Element extends EventTarget {
  constructor(tagName) {
    super();
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.className = "";
    this.textContent = "";
    this.open = false;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }
  matches(selector) {
    if (selector === "dialog[open]") return this.tagName === "dialog" && this.open;
    if (selector === "[role='menu']") return this.getAttribute("role") === "menu";
    return this.tagName === selector;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(",").map((part) => part.trim());
    return this.children.flatMap((child) => [...(selectors.some((part) => child.matches(part)) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  focus() {
    document.activeElement = this;
  }
}

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../../src/keyboard-shortcuts.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { installShortcuts } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

function fixture(t) {
  const document = Object.assign(new EventTarget(), {
    body: new Element("body"),
    activeElement: null,
    createElement: (tag) => new Element(tag),
    createTextNode(text) {
      const node = new Element("#text");
      node.textContent = text;
      return node;
    },
    getElementById(id) {
      return this.body.querySelectorAll("section").find((node) => node.id === id) ?? null;
    },
    querySelector(selector) {
      return this.body.querySelectorAll(selector)[0] ?? null;
    },
  });
  const content = document.createElement("section");
  content.id = "shortcut-groups";
  document.body.append(content);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  t.after(() => (previous ? Object.defineProperty(globalThis, "document", previous) : delete globalThis.document));
  const calls = [];
  const state = { ready: true };
  const handlers = Object.fromEntries(["saveAndBuild", "files", "sync", "preview", "logs", "search"].map((name) => [name, () => calls.push(name)]));
  installShortcuts({ ready: () => state.ready, ...handlers });
  function press(key, options = {}) {
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...options });
    document.dispatchEvent(event);
    return event;
  }
  return { document, content, calls, state, press };
}

for (const modifier of ["ctrlKey", "metaKey"]) {
  for (const [key, action] of [["s", "saveAndBuild"]]) {
    test(`${modifier}+${key} invokes only ${action} and prevents browser default`, (t) => {
      const { calls, press } = fixture(t);
      assert.equal(press(key, { [modifier]: true }).defaultPrevented, true);
      assert.deepEqual(calls, [action]);
    });

    test(`${modifier}+${key} leaves browser default outside the workspace`, (t) => {
      const { calls, state, press } = fixture(t);
      state.ready = false;
      assert.equal(press(key, { [modifier]: true }).defaultPrevented, false);
      assert.deepEqual(calls, []);
      state.ready = true;
      assert.equal(press(key, { [modifier]: true }).defaultPrevented, true);
      assert.deepEqual(calls, [action]);
    });

    test(`${modifier}+Shift+${key} does not save or build`, (t) => {
      const { calls, press } = fixture(t);
      assert.equal(press(key.toUpperCase(), { [modifier]: true, shiftKey: true }).defaultPrevented, false);
      assert.deepEqual(calls, []);
    });
  }
}

for (const modal of ["dialog", "menu"]) {
  test(`focused ${modal} suppresses save, build and search shortcuts`, (t) => {
    const { document, calls, press } = fixture(t);
    const overlay = document.createElement(modal === "dialog" ? "dialog" : "div");
    if (modal === "dialog") overlay.open = true;
    else overlay.setAttribute("role", "menu");
    const input = document.createElement("input");
    overlay.append(input);
    document.body.append(overlay);
    input.focus();
    assert.equal(document.activeElement, input);
    for (const modifier of ["ctrlKey", "metaKey"]) {
      for (const key of ["s", "r", "F"]) {
        assert.equal(press(key, { [modifier]: true, shiftKey: key === "F" }).defaultPrevented, false);
      }
    }
    assert.deepEqual(calls, []);
  });
}

test("Ctrl+Shift+F still invokes search, not save or build", (t) => {
  const { calls, press } = fixture(t);
  assert.equal(press("F", { ctrlKey: true, shiftKey: true }).defaultPrevented, true);
  assert.deepEqual(calls, ["search"]);
});

for (const modifier of ["ctrlKey", "metaKey"]) {
  test(`${modifier}+R preserves browser refresh`, (t) => {
    const { calls, press } = fixture(t);
    for (const shiftKey of [false, true]) {
      assert.equal(press("r", { [modifier]: true, shiftKey }).defaultPrevented, false);
    }
    assert.deepEqual(calls, []);
  });
}

const application = await readFile(new URL("../../src/application.ts", import.meta.url), "utf8");

// Execute the real build preflight up to snapshot collection, where compilation starts.
const preflight = application.match(
  /async function compileDocument\([\s\S]*?\): Promise<void \| false> \{([\s\S]*?)  const paths = await activeRepo.files\(\);/,
)[1];
const operation = { signal: { throwIfAborted() {} } };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
test("build waits for save before collecting files", async () => {
  const calls = [];
  let release;
  const saved = new Promise((resolve) => {
    release = resolve;
  });
  const run = new AsyncFunction("operation", "saveDocument", "repo", "saving", "createFileOperationProgress", "status", preflight + 'return "snapshot";');
  const pending = run(
    operation,
    async () => {
      calls.push("save");
      await saved;
      calls.push("saved");
    },
    {},
    Promise.resolve(),
    () => () => calls.push("prepare"),
    () => {},
  );
  assert.deepEqual(calls, ["save"]);
  release();
  assert.equal(await pending, "snapshot");
  assert.deepEqual(calls, ["save", "saved", "prepare"]);
});
test("failed save prevents build preparation without prompting or discarding", async () => {
  const failure = new Error("Storage write failed");
  const run = new AsyncFunction("operation", "saveDocument", preflight);
  await assert.rejects(
    run(operation, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});
