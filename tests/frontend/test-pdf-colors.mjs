// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const markup = await readFile("src/application.html", "utf8");
const bundle = await build({
  entryPoints: ["src/pdf-preview.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  plugins: [
    {
      name: "stub-pdfjs",
      setup(build) {
        build.onResolve({ filter: /^pdfjs-dist/ }, () => ({ path: "pdfjs", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents:
            "export const GlobalWorkerOptions = {}; export class TextLayer {} export function getDocument() { throw new Error('Unexpected PDF load'); }",
        }));
      },
    },
  ],
});

function createTestPreview(storage) {
  const elements = new Map(
    [...markup.matchAll(/id="([^"]+)"/g)].map(([, id]) => {
      const classes = new Set();
      return [
        id,
        {
          hidden: true,
          value: "",
          style: { removeProperty() {} },
          attributes: new Map(),
          classList: {
            toggle(name, force = !classes.has(name)) {
              if (force) classes.add(name);
              else classes.delete(name);
              return force;
            },
            contains: (name) => classes.has(name),
          },
          addEventListener() {},
          contains: () => true,
          closest: () => elements.get("preview-panel"),
          setAttribute(name, value) {
            this.attributes.set(name, value);
          },
          removeAttribute(name) {
            this.attributes.delete(name);
          },
          replaceChildren() {},
        },
      ];
    }),
  );
  const context = vm.createContext({
    module: { exports: {} },
    localStorage: storage,
    window: { document: { getElementById: (id) => elements.get(id) } },
    ResizeObserver: class {
      observe() {}
    },
    clearTimeout,
    cancelAnimationFrame() {},
    console,
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  const pdf = elements.get("pdf");
  const button = elements.get("pdf-invert-colors");
  const preview = context.module.exports.createPreview(pdf, elements.get("preview-empty"), () => {});
  return { pdf, button, preview };
}

const storageKey = "aux-pdf-colors-inverted";
function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("PDF color inversion toggles accessibly and survives preview resets", async () => {
  const storage = memoryStorage();
  const { pdf, button, preview } = createTestPreview(storage);
  assert.equal(pdf.classList.contains("pdf-colors-inverted"), false);
  button.onclick();
  assert.equal(pdf.classList.contains("pdf-colors-inverted"), true);
  assert.equal(button.attributes.get("aria-pressed"), "true");
  await preview.reset();
  assert.equal(pdf.classList.contains("pdf-colors-inverted"), true);
  assert.equal(button.attributes.get("aria-pressed"), "true");
  button.onclick();
  assert.equal(pdf.classList.contains("pdf-colors-inverted"), false);
  assert.equal(button.attributes.get("aria-pressed"), "false");
  assert.equal(storage.getItem(storageKey), "false");
});

test("PDF color preference is restored after refresh, including switching it off", () => {
  const storage = memoryStorage();
  createTestPreview(storage).button.onclick();
  assert.equal(storage.getItem(storageKey), "true");
  const refreshed = createTestPreview(storage);
  assert.equal(refreshed.pdf.classList.contains("pdf-colors-inverted"), true);
  assert.equal(refreshed.button.attributes.get("aria-pressed"), "true");
  refreshed.button.onclick();
  const next = createTestPreview(storage);
  assert.equal(next.pdf.classList.contains("pdf-colors-inverted"), false);
  assert.equal(next.button.attributes.get("aria-pressed"), "false");
});

test("unavailable storage does not break PDF color toggling", () => {
  const storage = {
    getItem() {
      throw new Error("Storage blocked");
    },
    setItem() {
      throw new Error("Storage blocked");
    },
  };
  const { pdf, button } = createTestPreview(storage);
  assert.equal(pdf.classList.contains("pdf-colors-inverted"), false);
  button.onclick();
  assert.equal(pdf.classList.contains("pdf-colors-inverted"), true);
  assert.equal(button.attributes.get("aria-pressed"), "true");
});
