// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/workspace/file-tree.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  plugins: [
    {
      name: "stub-icons",
      setup(build) {
        build.onResolve({ filter: /ui-icons\.js$/ }, () => ({ path: "icons", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: `export function icon(name) {
        const element = document.createElement("span");
        element.classList.add("icon"); element.dataset.icon = name; return element;
      }`,
        }));
      },
    },
  ],
});

function fixture() {
  // Only the element operations and selectors used by the factory, not a browser emulator.
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.attributes = new Map();
      this.classes = new Set();
      this.classList = {
        add: (name) => this.classes.add(name),
        toggle: (name, enabled) => (enabled ? this.classes.add(name) : this.classes.delete(name)),
      };
    }
    append(...children) {
      for (const child of children) {
        child.parent = this;
        this.children.push(child);
      }
    }
    replaceChildren(...children) {
      for (const child of this.children) child.parent = null;
      this.children = [];
      this.append(...children);
    }
    remove() {
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
    replaceWith(other) {
      const parent = this.parent;
      const index = parent.children.indexOf(this);
      parent.children[index] = other;
      other.parent = parent;
      this.parent = null;
    }
    setAttribute(name, value) {
      this.attributes.set(name, value);
    }
    removeAttribute(name) {
      this.attributes.delete(name);
    }
    addEventListener() {}
    matches(selector) {
      return selector.split(", ").some((part) => {
        if (part === ".icon") return this.classes.has("icon");
        if (part === "details[open]") return this.tag === "details" && this.open;
        if (part === "button:not(:disabled)") return this.tag === "button" && !this.disabled;
        if (part.endsWith("[data-path]")) return this.tag === part.split("[")[0] && this.dataset.path !== undefined;
        return this.tag === part;
      });
    }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
    closest(selector) {
      return this.matches(selector) ? this : this.parent?.closest(selector) || null;
    }
    contains(node) {
      return node === this || this.children.some((child) => child.contains(node));
    }
    get isConnected() {
      return document.body.contains(this);
    }
    focus() {
      document.activeElement = this;
      this.onfocus?.();
    }
    offsetWidth = 100;
    offsetHeight = 100;
  }
  const document = {
    body: new Element("body"),
    activeElement: null,
    createElement: (tag) => new Element(tag),
    createTextNode: () => new Element("#text"),
    addEventListener() {},
  };
  const context = vm.createContext({ document, window: { addEventListener() {} }, innerWidth: 800, innerHeight: 600, module: { exports: {} } });
  vm.runInContext(bundle.outputFiles[0].text, context);
  const state = {
    busy: false,
    workspaceReady: true,
    repo: { dir: "/workspace/a" },
    treeClipboard: null,
    selectedTreePath: "chapter/main.tex",
    file: "chapter/main.tex",
    changedPaths: new Set(),
    dirty: false,
    treeProject: null,
    project: 1,
  };
  const selections = [],
    actions = [];
  const blocked = new Set(),
    readOnly = new Set();
  const tree = new Element("div");
  document.body.append(tree);
  const api = context.module.exports.createFileTree(tree, () => state, {
    setSelectedPath(path) {
      selections.push(path);
      state.selectedTreePath = path;
    },
    setTreeProject(project) {
      state.treeProject = project;
    },
    pathWritable: (path) => !readOnly.has(path),
    actionDisabled: (id) => blocked.has(id),
    menuAction: (...args) => actions.push(args),
    fileButton: () => new Element("button"),
    syncActions() {},
  });
  api.renderTree(["chapter/main.tex", "chapter/notes.txt"]);
  const row = (path) => tree.querySelectorAll("button[data-path], summary[data-path]").find((item) => item.dataset.path === path);
  const folder = () => tree.querySelector("details");
  const menu = () => document.body.children.find((item) => item.dataset.treeMenu !== undefined);
  const openMenu = (target = row("chapter/main.tex")) => api.openTreeMenu({ target, preventDefault() {}, clientX: 20, clientY: 30 });
  const action = (id) => menu().children.find((item) => item.dataset.action === id);
  return { api, state, tree, row, folder, menu, openMenu, action, selections, actions, blocked, readOnly };
}

test("existing folder handlers read live busy state without blocking expansion or changing selection", () => {
  const f = fixture();
  const summary = f.row("chapter");
  f.state.busy = true;
  summary.onclick();
  summary.onfocus();
  // Native details expansion is independent of selection handlers; simulate its toggle notification.
  f.folder().open = true;
  f.folder().ontoggle();
  assert.equal(f.folder().open, true);
  assert.equal(summary.querySelector(".icon").dataset.icon, "open");
  assert.equal(f.state.selectedTreePath, "chapter/main.tex");
  assert.deepEqual(f.selections, []);
  assert.equal(f.row("chapter/main.tex").dataset.selected, "true");
  f.state.busy = false;
  summary.onclick();
  assert.equal(f.state.selectedTreePath, "chapter");
  assert.equal(summary.dataset.selected, "true");
  assert.equal(f.row("chapter/main.tex").dataset.selected, "false");
});

test("rerender retains expanded folders only for the same project", () => {
  const f = fixture();
  f.api.expandTreePath("chapter/main.tex");
  const previous = f.folder();
  f.api.renderTree(["chapter/main.tex", "chapter/new.tex"]);
  assert.notEqual(f.folder(), previous);
  assert.equal(f.folder().open, true);
  f.state.project = 2;
  f.api.renderTree(["chapter/main.tex"]);
  assert.equal(f.folder().open, false);
  assert.equal(f.state.treeProject, 2);
});

test("context menu reads current availability and refuses dispatch if busy changes after opening", () => {
  const f = fixture();
  for (const patch of [{ busy: true }, { repo: null }, { workspaceReady: false }]) {
    const previous = { ...f.state };
    Object.assign(f.state, patch);
    f.openMenu();
    assert.equal(f.menu(), undefined);
    assert.deepEqual(f.selections, []);
    Object.assign(f.state, previous);
  }
  f.blocked.add("rename");
  f.readOnly.add("chapter/main.tex");
  f.openMenu();
  assert.equal(f.action("rename").disabled, true);
  assert.equal(f.action("cut").disabled, true);
  assert.equal(f.action("download").disabled, false);
  const download = f.action("download");
  f.state.busy = true;
  download.onclick();
  assert.equal(f.menu(), undefined);
  assert.deepEqual(f.actions, []);
  f.state.busy = false;
  f.openMenu();
  f.action("download").onclick();
  assert.deepEqual(f.actions, [["download", "Download", "chapter/main.tex", "chapter"]]);
});

test("clipboard paste and cut highlighting are scoped to the live workspace and destination", () => {
  const f = fixture();
  f.state.treeClipboard = { dir: "/workspace/other", path: "chapter", type: "cut" };
  f.api.syncTree();
  f.openMenu();
  assert.equal(f.action("paste").disabled, true);
  assert.equal(f.row("chapter/main.tex").classes.has("tree-cut"), false);
  f.state.treeClipboard = { dir: f.state.repo.dir, path: "chapter", type: "cut" };
  f.api.syncTree();
  assert.equal(f.row("chapter").classes.has("tree-cut"), true);
  assert.equal(f.row("chapter/main.tex").classes.has("tree-cut"), true);
  f.openMenu();
  assert.equal(f.action("paste").disabled, true, "cannot paste a folder into itself");
  f.state.treeClipboard = { dir: f.state.repo.dir, path: "other.tex", type: "copy" };
  f.openMenu();
  assert.equal(f.action("paste").disabled, false);
  f.readOnly.add("chapter");
  f.openMenu();
  assert.equal(f.action("paste").disabled, true);
});
