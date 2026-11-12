// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

// Minimal DOM: exercise the real modal lifecycle, shell, buttons and queue.
class Element extends EventTarget {
  constructor(tagName) {
    super();
    Object.assign(this, { tagName, children: [], attributes: new Map(), className: "", open: false });
    this.classList = { add: (name) => { this.className += ` ${name}`; } };
  }
  set innerHTML(value) { assert.fail(`Unsafe HTML: ${value}`); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...nodes) {
    for (const node of nodes) { node.parentElement = this; this.children.push(node); }
  }
  prepend(...nodes) {
    for (const node of nodes) node.parentElement = this;
    this.children.unshift(...nodes);
  }
  remove() {
    const siblings = this.parentElement?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  get isConnected() { return this === document.body || !!this.parentElement?.isConnected; }
  matches(selector) {
    if (selector === ":disabled") return !!this.disabled;
    if (selector === "dialog[open]") return this.tagName === "dialog" && this.open;
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tagName === selector;
  }
  closest() { return null; }
  contains(element) { return element === this || this.children.some((child) => child.contains(element)); }
  getClientRects() { return [{}]; }
  getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 100 }; }
  querySelectorAll(selector) {
    if (selector.startsWith(":scope > ")) return this.children.filter((child) => child.matches(selector.slice(9)));
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() { document.activeElement = this; }
  showModal() { this.open = true; }
  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event("close"));
  }
  requestClose() {
    if (this.open && this.dispatchEvent(new Event("cancel", { cancelable: true }))) this.close();
  }
  requestSubmit() { this.dispatchEvent(new Event("submit", { cancelable: true })); }
  click() {
    this.onclick?.();
    if (this.tagName === "button" && this.type === "submit") {
      let form = this.parentElement;
      while (form && form.tagName !== "form") form = form.parentElement;
      form?.requestSubmit();
    }
  }
}

function fixture(t) {
  const document = Object.assign(new EventTarget(), {
    body: new Element("body"), activeElement: null,
    createElement: (tag) => new Element(tag),
    querySelectorAll(selector) { return this.body.querySelectorAll(selector); },
  });
  for (const [name, value] of Object.entries({ document, window: new EventTarget(), HTMLElement: Element })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  return { document, opener };
}

async function load(relativePath, plugins = []) {
  const bundle = await build({
    entryPoints: [new URL(relativePath, import.meta.url).pathname],
    bundle: true, write: false, format: "esm", platform: "node", plugins,
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
}
const { uploadConflictDialog, confirmDialog, alertDialog } = await load("../../src/modal-dialogs.ts", [{
  name: "stub-icons",
  setup(build) {
    build.onResolve({ filter: /ui-icons\.js$/ }, () => ({ path: "icons", namespace: "test" }));
    build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: 'export function icon() { return document.createElement("svg"); }' }));
  },
}]);
const { uniqueUploadPath } = await load("../../src/workspace/upload-conflicts.ts");

async function activeDialog(document) {
  for (let i = 0; i < 15; i++) {
    const dialog = document.querySelectorAll("dialog[open]")[0];
    if (dialog) return dialog;
    await Promise.resolve();
  }
  assert.fail("Expected an open dialog");
}

for (const action of ["replace", "skip", "keep-both"]) {
  for (const checked of [false, true]) {
    test(`upload conflict: ${action}, apply to remaining=${checked}`, async (t) => {
      const { document, opener } = fixture(t);
      const path = 'figures/<img src=x onerror="bad()">.png';
      const result = uploadConflictDialog(path);
      const dialog = await activeDialog(document);
      assert.ok(dialog.className.includes("dialog-shell"));
      assert.equal(dialog.getAttribute("aria-labelledby"), dialog.querySelector("h2").id);
      assert.equal(dialog.getAttribute("aria-describedby"), dialog.querySelector("p").id);
      assert.ok(dialog.querySelector("p").textContent.includes(path));
      assert.equal(dialog.querySelector("p").children.length, 0);
      const checkbox = dialog.querySelector("input");
      assert.equal(checkbox.type, "checkbox");
      assert.equal(checkbox.checked, false);
      assert.equal(dialog.querySelector("label").htmlFor, checkbox.id);
      assert.equal(dialog.querySelector("label").querySelector("span").textContent, "Apply to remaining conflicts");
      const buttons = dialog.querySelector(".dialog-actions").children;
      assert.deepEqual(buttons.map((button) => button.textContent), ["Cancel", "Replace", "Skip", "Keep both"]);
      assert.equal(document.activeElement, buttons[3], "Default focus must not replace a file");
      checkbox.checked = checked;
      buttons[{ replace: 1, skip: 2, "keep-both": 3 }[action]].click();
      assert.deepEqual(await result, { action, applyToRemaining: checked });
      assert.equal(document.querySelectorAll("dialog").length, 0);
      assert.equal(document.activeElement, opener);
    });
  }
}

for (const dismissal of ["cancel", "close", "escape", "backdrop", "programmatic"]) {
  test(`upload conflict dismissal aborts: ${dismissal}`, async (t) => {
    const { document, opener } = fixture(t);
    const result = uploadConflictDialog("main.tex");
    const dialog = await activeDialog(document);
    dialog.querySelector("input").checked = true;
    if (dismissal === "cancel") dialog.querySelector(".dialog-actions").children[0].click();
    if (dismissal === "close") dialog.querySelector(".dialog-close").click();
    if (dismissal === "escape") dialog.requestClose();
    if (dismissal === "programmatic") dialog.close();
    if (dismissal === "backdrop") {
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new Event(type);
        Object.defineProperties(event, Object.fromEntries(Object.entries({
          target: dialog, pointerId: 1, isPrimary: true, button: 0, clientX: -10, clientY: -10,
        }).map(([key, value]) => [key, { value }])));
        document.dispatchEvent(event);
      }
    }
    assert.equal(await result, null);
    assert.equal(document.activeElement, opener);
    assert.equal(document.querySelectorAll("dialog").length, 0);
  });
}

test("upload conflicts share the existing queue and recover from showModal failure", async (t) => {
  const { document } = fixture(t);
  const first = confirmDialog("First");
  const conflict = uploadConflictDialog("queued.tex");
  const last = alertDialog("Last");
  let dialog = await activeDialog(document);
  assert.equal(document.querySelectorAll("dialog").length, 1);
  assert.equal(dialog.querySelector("p").textContent, "First");
  dialog.requestClose();
  assert.equal(await first, false);
  dialog = await activeDialog(document);
  assert.equal(document.querySelectorAll("dialog").length, 1);
  dialog.querySelector(".dialog-actions").children[2].click();
  assert.deepEqual(await conflict, { action: "skip", applyToRemaining: false });
  dialog = await activeDialog(document);
  assert.equal(dialog.querySelector("p").textContent, "Last");
  dialog.requestClose();
  await last;

  const createElement = document.createElement;
  document.createElement = (tag) => {
    const element = createElement(tag);
    if (tag === "dialog") element.showModal = () => { throw new Error("Cannot show modal"); };
    return element;
  };
  await assert.rejects(uploadConflictDialog("failed.tex"), /Cannot show modal/);
  assert.equal(document.querySelectorAll("dialog").length, 0);
  document.createElement = createElement;
  const recovered = uploadConflictDialog("recovered.tex");
  (await activeDialog(document)).requestClose();
  assert.equal(await recovered, null);
});

for (const [path, expected] of [
  ["main.tex", "main (2).tex"], ["figures/image.png", "figures/image (2).png"],
  ["README", "README (2)"], [".latexmkrc", ".latexmkrc (2)"],
  ["archive.tar.gz", "archive.tar (2).gz"], ["name.", "name. (2)"],
  ["folder.with.dots/名.tex", "folder.with.dots/名 (2).tex"],
]) {
  test(`unique sibling: ${path}`, async () => {
    assert.equal(await uniqueUploadPath(path, () => false), expected);
  });
}

test("unique siblings check every collision including reserved batch paths", async () => {
  const occupied = new Set(["main.tex", "main (2).tex", "main (3).tex"]);
  const checked = [];
  const exists = async (path) => { checked.push(path); return occupied.has(path); };
  const first = await uniqueUploadPath("main.tex", exists);
  assert.equal(first, "main (4).tex");
  occupied.add(first);
  assert.equal(await uniqueUploadPath("main.tex", exists), "main (5).tex");
  assert.deepEqual(checked.slice(0, 3), ["main (2).tex", "main (3).tex", "main (4).tex"]);
});

test("invalid project paths are rejected before checking existence", async () => {
  for (const path of ["", "/main.tex", "../a", "a/../b", "./a", "a//b", "a/", "a\\b", "C:/a", ".git/config", "a/.GIT/b", "a\0b", "a\nb"]) {
    await assert.rejects(uniqueUploadPath(path, () => assert.fail("Must not check unsafe paths")), /Invalid project file path/);
  }
});

test("existence errors propagate without selecting an unsafe filename", async () => {
  const error = new Error("Storage unavailable");
  await assert.rejects(uniqueUploadPath("main.tex", async () => { throw error; }), (caught) => caught === error);
});
