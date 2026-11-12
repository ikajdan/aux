// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tag = tag;
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.id = "";
    this.textContent = "";
    this.disabled = this.hidden = false;
    this.classList = { toggle() {} };
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  append(...nodes) {
    for (const node of nodes) {
      if (node.parentElement) node.parentElement.children = node.parentElement.children.filter((child) => child !== node);
      node.parentElement = this;
      this.children.push(node);
    }
  }
  before(node) { this.parentElement.append(node); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  closest(tag) { return this.tag === tag ? this : this.parentElement?.closest(tag) ?? null; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  focus() { document.activeElement = this; }
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 100, bottom: 130, left: 40, width: 200 }; }
  get options() { return this.children.flatMap((child) => child.tag === "option" ? [child] : child.options); }
  get selectedOptions() { return [this.options[this.selectedIndex]].filter(Boolean); }
}

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../../src/select-control.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "node",
  plugins: [{ name: "icons", setup(build) {
    build.onResolve({ filter: /ui-icons\.js$/ }, () => ({ path: "icons", namespace: "mock" }));
    build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: 'export const icon = () => document.createElement("svg");' }));
  } }],
});
const { createSelect } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

function fixture(t, { dialog = false, label = true } = {}) {
  const document = new EventTarget();
  document.body = new Element("body");
  document.createElement = (tag) => new Element(tag);
  for (const [key, value] of Object.entries({ document, window: new EventTarget(), innerHeight: 800, innerWidth: 1000 })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  const parent = dialog ? new Element("dialog") : document.body;
  if (dialog) document.body.append(parent);
  const select = new Element("select");
  select.id = "branches";
  select.labels = label ? [new Element("label")] : [];
  select.selectedIndex = 0;
  for (const name of ["Alpha", "Beta", "Gamma", "Delta"]) {
    const option = new Element("option");
    option.textContent = name;
    select.append(option);
  }
  parent.append(select);
  const initialize = () => {
    const api = createSelect(select);
    const wrapper = select.parentElement;
    const trigger = wrapper.children[1];
    const popup = parent.children.find((child) => child.getAttribute("role") === "listbox");
    return { api, trigger, popup };
  };
  return { document, parent, select, initialize };
}
function key(trigger, key) {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  trigger.dispatchEvent(event);
  return event;
}
function active(trigger) { return trigger.getAttribute("aria-activedescendant"); }

test("arrows and endpoints skip unavailable options, stop at boundaries, and retain trigger focus", (t) => {
  const f = fixture(t);
  f.select.options[0].hidden = true;
  f.select.options[2].disabled = true;
  const { trigger, popup } = f.initialize();
  key(trigger, "Home");
  assert.equal(active(trigger), "branches-option-1");
  assert.equal(f.document.activeElement, trigger);
  assert.equal(popup.children[0].style.display, "none");
  key(trigger, "ArrowDown");
  assert.equal(active(trigger), "branches-option-3");
  key(trigger, "ArrowDown");
  assert.equal(active(trigger), "branches-option-3");
  key(trigger, "ArrowUp");
  assert.equal(active(trigger), "branches-option-1");
  key(trigger, "End");
  assert.equal(active(trigger), "branches-option-3");
  key(trigger, "Escape");
  assert.equal(popup.hidden, true);
  assert.equal(active(trigger), null);
  assert.equal(f.select.selectedIndex, 0);
});

test("all unavailable and empty lists never expose an active descendant", (t) => {
  const f = fixture(t);
  f.select.options.forEach((option) => { option.disabled = true; });
  const { api, trigger } = f.initialize();
  for (const name of ["Home", "End", "ArrowDown", "ArrowUp", "Enter"]) {
    key(trigger, name);
    assert.equal(active(trigger), null);
  }
  f.select.replaceChildren();
  api.rebuild();
  assert.equal(trigger.disabled, true);
  key(trigger, "End");
  assert.equal(active(trigger), null);
});

test("optgroup restrictions, commitment events, typeahead and Tab", (t) => {
  const f = fixture(t);
  const group = new Element("optgroup");
  group.disabled = true;
  group.append(f.select.options[0]);
  f.select.append(group);
  const { trigger, popup } = f.initialize();
  assert.equal(popup.children[3].disabled, true);
  let inputs = 0, changes = 0;
  f.select.addEventListener("input", () => inputs++);
  f.select.addEventListener("change", () => changes++);
  key(trigger, "g");
  assert.equal(active(trigger), "branches-option-1");
  key(trigger, "Enter");
  assert.equal(f.select.selectedIndex, 1);
  assert.equal(inputs, 1);
  assert.equal(changes, 1);
  key(trigger, "ArrowDown");
  assert.equal(key(trigger, "Tab").defaultPrevented, false);
  assert.equal(popup.hidden, true);
});

test("names get usable IDs and dialog popups remain in the dialog and close with it", (t) => {
  const f = fixture(t, { dialog: true });
  const { trigger, popup } = f.initialize();
  assert.equal(trigger.getAttribute("aria-labelledby"), "branches-label-0 branches-value");
  assert.equal(f.select.labels[0].id, "branches-label-0");
  assert.equal(popup.parentElement, f.parent);
  key(trigger, "ArrowDown");
  assert.equal(popup.style.top, "134px");
  f.parent.dispatchEvent(new Event("close"));
  assert.equal(popup.hidden, true);
});

for (const attribute of ["aria-label", "aria-labelledby"]) {
  test(`preserves ${attribute} on trigger and popup`, (t) => {
    const f = fixture(t);
    f.select.setAttribute(attribute, "Branch name");
    const { trigger, popup } = f.initialize();
    assert.equal(trigger.getAttribute(attribute), "Branch name");
    assert.equal(popup.getAttribute(attribute), "Branch name");
  });
}
