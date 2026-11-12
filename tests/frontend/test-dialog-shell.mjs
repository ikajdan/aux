// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Supply only the DOM primitives used by the shell; all shell logic is bundled below.
class Element extends EventTarget {
  constructor(tagName) {
    super();
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.className = "";
    this.dataset = {};
    this.open = false;
    this.disabled = false;
    this.classList = {
      add: (name) => {
        this.className = `${this.className} ${name}`.trim();
      },
    };
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }
  prepend(...nodes) {
    for (const node of nodes) node.parentElement = this;
    this.children.unshift(...nodes);
  }
  matches(selector) {
    if (selector === "dialog[data-dialog-title]") return this.tagName === "dialog" && this.dataset.dialogTitle !== undefined;
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tagName === selector;
  }
  querySelectorAll(selector) {
    if (selector.startsWith(":scope > ")) return this.children.filter((child) => child.matches(selector.slice(9)));
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event("close"));
  }
  requestClose() {
    if (this.open && this.dispatchEvent(new Event("cancel", { cancelable: true }))) this.close();
  }
  click() {
    if (this.disabled) return;
    const event = new Event("click", { cancelable: true });
    this.dispatchEvent(event);
    this.onclick?.(event);
    if (!event.defaultPrevented && this.tagName === "button" && (!this.type || this.type === "submit")) {
      let parent = this.parentElement;
      while (parent && parent.tagName !== "form") parent = parent.parentElement;
      parent?.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  }
}

function fixture(t) {
  const document = {
    body: new Element("body"),
    createElement: (tag) => new Element(tag),
    querySelectorAll(selector) {
      return this.body.querySelectorAll(selector);
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  t.after(() => (previous ? Object.defineProperty(globalThis, "document", previous) : delete globalThis.document));
  return document;
}

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../../src/ui/dialog-shell.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [
    {
      name: "stub-ui-icons",
      setup(build) {
        build.onResolve({ filter: /ui-icons\.js$/ }, () => ({ path: "ui-icons", namespace: "test-icons" }));
        build.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({
          contents: 'export function icon() { return document.createElement("svg"); }',
        }));
      },
    },
  ],
});
const { configureDialog, initializeDialogShells } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

function dialogWithBody(document) {
  const dialog = document.createElement("dialog");
  const body = document.createElement("form");
  body.className = "dialog-body";
  dialog.append(body);
  document.body.append(dialog);
  return { dialog, body };
}
const options = { title: "Settings", titleId: "settings-heading" };

test("requires a direct body and refuses duplicate configuration", (t) => {
  const document = fixture(t);
  const dialog = document.createElement("dialog");
  assert.throws(() => configureDialog(dialog, options), /direct \.dialog-body/);
  const wrapper = document.createElement("div");
  const nested = document.createElement("form");
  nested.className = "dialog-body";
  wrapper.append(nested);
  dialog.append(wrapper);
  assert.throws(() => configureDialog(dialog, options), /direct \.dialog-body/);
  const valid = dialogWithBody(document);
  configureDialog(valid.dialog, options);
  assert.throws(() => configureDialog(valid.dialog, options), /already configured/);
  assert.equal(valid.dialog.querySelectorAll(":scope > .dialog-heading").length, 1);
});

for (const icon of [undefined, "settings"]) {
  test(`configuration preserves body and labels a safe text title (${icon ?? "no icon"})`, (t) => {
    const document = fixture(t);
    const { dialog, body } = dialogWithBody(document);
    const input = document.createElement("input");
    body.append(input);
    const title = '<img src=x onerror="alert(1)"> & Settings';
    const shell = configureDialog(dialog, { ...options, title, icon });
    assert.equal(shell.dialog, dialog);
    assert.equal(shell.body, body);
    assert.deepEqual(dialog.children, [shell.header, body]);
    assert.equal(body.children[0], input);
    assert.ok(dialog.className.split(/\s+/).includes("dialog-shell"));
    assert.equal(shell.header.tagName, "header");
    const heading = shell.header.querySelector("h2");
    assert.equal(dialog.getAttribute("aria-labelledby"), heading.id);
    assert.equal(heading.id, options.titleId);
    assert.equal(shell.title.tagName, "span");
    assert.equal(shell.title.textContent, title);
    assert.equal(shell.title.children.length, 0);
    assert.equal(shell.title.innerHTML, undefined, "title uses textContent, not innerHTML");
    assert.equal(heading.children.at(-1), shell.title);
    assert.equal(heading.querySelectorAll("svg").length, icon ? 1 : 0);
    assert.equal(shell.close.querySelectorAll("svg").length, 1);
    assert.equal(shell.close.type, "button");
    assert.equal(shell.close.getAttribute("aria-label"), "Close dialog");
    assert.equal(shell.close.autofocus, false);
  });
}

test("closed or disabled close control does not request closure", (t) => {
  const document = fixture(t);
  const { dialog } = dialogWithBody(document);
  const { close } = configureDialog(dialog, options);
  let requests = 0;
  dialog.requestClose = () => {
    requests++;
  };
  close.onclick();
  dialog.open = true;
  close.disabled = true;
  close.onclick(); // Bypass native disabled-click suppression to exercise the helper's guard.
  assert.equal(requests, 0);
  close.disabled = false;
  close.click();
  assert.equal(requests, 1);
});

for (const native of [true, false]) {
  test(`close respects cancel prevention and never submits (${native ? "requestClose" : "fallback"})`, (t) => {
    const document = fixture(t);
    const { dialog } = dialogWithBody(document);
    const outer = document.createElement("form");
    outer.append(dialog);
    let submissions = 0;
    outer.addEventListener("submit", () => submissions++);
    const { close } = configureDialog(dialog, options);
    if (!native) dialog.requestClose = undefined;
    dialog.open = true;
    let cancellations = 0;
    let closures = 0;
    const prevent = (event) => {
      cancellations++;
      assert.equal(event.cancelable, true);
      event.preventDefault();
    };
    dialog.addEventListener("cancel", prevent);
    dialog.addEventListener("close", () => closures++);
    close.click();
    assert.equal(cancellations, 1);
    assert.equal(dialog.open, true);
    assert.equal(closures, 0);
    dialog.removeEventListener("cancel", prevent);
    close.click();
    assert.equal(dialog.open, false);
    assert.equal(closures, 1);
    assert.equal(submissions, 0);
  });
}

test("static initialization preserves IDs, body contents and optional icon/autofocus", (t) => {
  const document = fixture(t);
  for (const decorated of [false, true]) {
    const { dialog, body } = dialogWithBody(document);
    const prefix = decorated ? "decorated" : "plain";
    dialog.id = `${prefix}-dialog`;
    dialog.setAttribute("aria-labelledby", `${prefix}-heading`);
    dialog.dataset = {
      dialogTitle: `${prefix} title`,
      dialogClose: `${prefix}-close`,
      dialogTitleText: `${prefix}-text`,
      ...(decorated ? { dialogIcon: "settings" } : {}),
    };
    if (decorated) dialog.setAttribute("data-dialog-close-autofocus", "");
    const input = document.createElement("input");
    input.value = "unsaved";
    body.append(input);
  }
  const ignored = document.createElement("dialog");
  document.body.append(ignored);
  initializeDialogShells();
  for (const dialog of document.querySelectorAll("dialog[data-dialog-title]")) {
    const prefix = dialog.id.replace("-dialog", "");
    const heading = dialog.querySelector("h2");
    const close = dialog.querySelector("button");
    assert.equal(heading.id, `${prefix}-heading`);
    assert.equal(dialog.getAttribute("aria-labelledby"), heading.id);
    assert.equal(heading.querySelector("span").id, `${prefix}-text`);
    assert.equal(heading.querySelector("span").textContent, `${prefix} title`);
    assert.equal(close.id, `${prefix}-close`);
    assert.equal(close.autofocus, prefix === "decorated");
    assert.equal(heading.querySelectorAll("svg").length, prefix === "decorated" ? 1 : 0);
    assert.equal(dialog.children[1].children[0].value, "unsaved");
    assert.equal(dialog.querySelectorAll(":scope > .dialog-heading").length, 1);
  }
  assert.equal(ignored.children.length, 0);
});
