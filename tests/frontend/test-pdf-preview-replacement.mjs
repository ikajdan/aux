// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const markup = await readFile("src/application.html", "utf8");
const bundle = await build({
  entryPoints: ["src/pdf-preview.ts"], bundle: true, write: false, format: "cjs",
  plugins: [{ name: "stub-pdfjs", setup(build) {
    build.onResolve({ filter: /^pdfjs-dist/ }, () => ({ path: "pdfjs", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export const GlobalWorkerOptions = {}; export class TextLayer {} export const getDocument = globalThis.loadPDF;",
    }));
  } }],
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  const elements = new Map();
  function element() {
    const classes = new Set();
    return {
      hidden: true, value: "", children: [], dataset: {}, attributes: new Map(),
      clientWidth: 600, clientTop: 0, scrollTop: 0,
      style: { setProperty() {}, removeProperty() {} },
      classList: {
        toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); return force; },
        contains: (name) => classes.has(name),
      },
      addEventListener() {}, contains: () => true,
      closest: () => elements.get("preview-panel"),
      getBoundingClientRect: () => ({ height: 800, top: 0 }),
      setAttribute(name, value) { this.attributes.set(name, value); },
      removeAttribute(name) { this.attributes.delete(name); },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
    };
  }
  for (const [, id] of markup.matchAll(/id="([^"]+)"/g)) elements.set(id, element());
  const loads = [];
  const reports = [];
  const context = vm.createContext({
    module: { exports: {} }, console, clearTimeout, cancelAnimationFrame() {},
    localStorage: { getItem: () => null },
    window: { document: { getElementById: (id) => elements.get(id), createElement: element } },
    ResizeObserver: class { observe() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    loadPDF() {
      const pending = deferred();
      const task = { ...pending, destroyed: 0, async destroy() {
        this.destroyed++;
        pending.reject(new Error("Loading task destroyed"));
      } };
      loads.push(task);
      return task;
    },
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  const pdf = elements.get("pdf");
  const preview = context.module.exports.createPreview(pdf, elements.get("preview-empty"), (...args) => reports.push(args));
  const blob = () => new Blob(["PDF"]);
  async function start(signal) {
    const promise = preview.show(blob(), signal);
    // Blob.arrayBuffer and the loading task are separate asynchronous stages.
    await new Promise((resolve) => setImmediate(resolve));
    return { promise, task: loads.at(-1) };
  }
  function document({ pages = 1, getPage } = {}) {
    return { numPages: pages, getPage: getPage || (async () => ({
      getViewport: () => ({ width: 600, height: 800 }), cleanup() {},
    })) };
  }
  async function install() {
    const loading = await start();
    loading.task.resolve(document());
    await loading.promise;
    return { node: pdf.children[0], task: loading.task };
  }
  return { elements, pdf, preview, loads, reports, start, document, install };
}

function assertDisplayed(harness, previous) {
  assert.equal(harness.pdf.hidden, false);
  assert.equal(harness.pdf.children[0], previous.node);
  assert.equal(harness.elements.get("preview-empty").hidden, true);
  assert.equal(harness.elements.get("pdf-controls").hidden, false);
  assert.equal(previous.task.destroyed, 0);
}

test("previous PDF, controls, scroll and sync remain intact until the replacement is ready", async () => {
  const h = setup();
  const previous = await h.install();
  h.pdf.scrollTop = 123;
  h.preview.setSyncEnabled(true);
  const loading = await h.start();
  assertDisplayed(h, previous);
  assert.equal(h.pdf.scrollTop, 123);
  assert.equal(h.pdf.classList.contains("synctex-picking"), true);
  const page = deferred();
  loading.task.resolve(h.document({ getPage: () => page.promise }));
  await new Promise((resolve) => setImmediate(resolve));
  assertDisplayed(h, previous);
  page.resolve({ getViewport: () => ({ width: 400, height: 800 }), cleanup() {} });
  await loading.promise;
  assert.notEqual(h.pdf.children[0], previous.node);
  assert.equal(previous.task.destroyed, 1);
  assert.equal(loading.task.destroyed, 0);
  assert.equal(h.pdf.scrollTop, 0);
  assert.equal(h.pdf.classList.contains("synctex-picking"), false);
});

test("a failed PDF load keeps the previous document and sync enabled", async () => {
  const h = setup();
  const previous = await h.install();
  h.preview.setSyncEnabled(true);
  const loading = await h.start();
  const rejected = assert.rejects(loading.promise, /Invalid PDF/);
  loading.task.reject(new Error("Invalid PDF"));
  await rejected;
  assertDisplayed(h, previous);
  assert.equal(h.pdf.classList.contains("synctex-picking"), true);
  assert.equal(loading.task.destroyed, 1);
});

test("page preparation failure does not publish a partial replacement", async () => {
  const h = setup();
  const previous = await h.install();
  const loading = await h.start();
  loading.task.resolve(h.document({ pages: 2, getPage: async (number) => {
    if (number === 2) throw new Error("Broken page");
    return { getViewport: () => ({ width: 600, height: 800 }), cleanup() {} };
  } }));
  await assert.rejects(loading.promise, /Broken page/);
  assertDisplayed(h, previous);
  assert.equal(h.pdf.children.length, 1);
  assert.equal(loading.task.destroyed, 1);
});

test("canceling a pending load preserves the previous PDF", async () => {
  const h = setup();
  const previous = await h.install();
  const controller = new AbortController();
  const loading = await h.start(controller.signal);
  const rejected = assert.rejects(loading.promise, (error) => error.name === "AbortError");
  controller.abort();
  await rejected;
  assertDisplayed(h, previous);
  assert.equal(loading.task.destroyed, 1);
});

test("reset cancels pending replacement and clears the old document without late publication", async () => {
  const h = setup();
  const previous = await h.install();
  const loading = await h.start();
  await h.preview.reset();
  await loading.promise;
  assert.equal(h.pdf.hidden, true);
  assert.equal(h.pdf.children.length, 0);
  assert.equal(h.elements.get("preview-empty").hidden, false);
  assert.equal(previous.task.destroyed, 1);
  assert.equal(loading.task.destroyed, 1);
});

test("a newer show supersedes a pending replacement without clearing the displayed PDF", async () => {
  const h = setup();
  const previous = await h.install();
  const first = await h.start();
  const second = await h.start();
  await first.promise;
  assertDisplayed(h, previous);
  second.task.resolve(h.document({ pages: 2 }));
  await second.promise;
  assert.equal(h.pdf.children.length, 2);
  assert.equal(first.task.destroyed, 1);
  assert.equal(second.task.destroyed, 0);
});

test("canceling before Blob data resolves cannot start a late PDF load", async () => {
  const h = setup();
  const previous = await h.install();
  const controller = new AbortController();
  const data = deferred();
  const loading = h.preview.show({ arrayBuffer: () => data.promise }, controller.signal);
  const rejected = assert.rejects(loading, (error) => error.name === "AbortError");
  controller.abort();
  data.resolve(new ArrayBuffer(1));
  await rejected;
  assertDisplayed(h, previous);
  assert.equal(h.loads.length, 1);
});

test("failure on the first preview retains the empty state with an actionable error", async () => {
  const h = setup();
  const loading = await h.start();
  loading.task.reject(new Error("Invalid PDF"));
  await assert.rejects(loading.promise, /Invalid PDF/);
  assert.equal(h.pdf.children.length, 0);
  assert.match(h.elements.get("preview-empty").textContent, /Invalid PDF/);
});
