// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/image-preview.ts"], bundle: true, write: false, format: "cjs",
});

function setup() {
  function element(tagName) {
    return {
      tagName, children: [], attributes: new Map(), hidden: false,
      naturalWidth: 0, naturalHeight: 0,
      setAttribute(name, value) { this.attributes.set(name, value); },
      removeAttribute(name) { this.attributes.delete(name); if (name === "src") this.src = ""; },
      append(...children) {
        for (const child of children) { child.parent = this; this.children.push(child); }
      },
      replaceChildren() { for (const child of this.children) child.parent = null; this.children = []; },
      remove() { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; },
    };
  }
  const created = [];
  const revoked = [];
  const context = vm.createContext({
    module: { exports: {} }, Blob,
    document: { createElement: element },
    URL: {
      createObjectURL(blob) { const url = `blob:image-${created.length}`; created.push({ url, blob }); return url; },
      revokeObjectURL(url) { revoked.push(url); },
    },
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  const container = element("div");
  const preview = context.module.exports.createImagePreview(container);
  const image = () => container.children.find(child => child.tagName === "img");
  const details = () => container.children.find(child => child.tagName === "dl");
  function values() {
    const children = details().children;
    return Object.fromEntries(children.filter(child => child.tagName === "dt")
      .map(term => [term.textContent, children[children.indexOf(term) + 1].textContent]));
  }
  return { ...context.module.exports, container, preview, created, revoked, image, details, values };
}

test("image details expose intrinsic dimensions, byte size and filename format after loading", () => {
  const h = setup();
  h.preview.show(new Uint8Array(1536), "images/photo.JPEG");
  const image = h.image();
  assert.equal(h.container.hidden, false);
  assert.equal(image.hidden, true);
  assert.equal(h.details().hidden, true);
  assert.equal(h.container.children[1].textContent, "Loading image…");
  assert.equal(h.container.children[1].attributes.get("role"), "status");
  assert.equal(h.created[0].blob.type, "image/jpeg");
  image.naturalWidth = 2048;
  image.naturalHeight = 1024;
  image.onload();
  assert.equal(image.hidden, false);
  assert.equal(h.details().hidden, false);
  assert.equal(h.details().attributes.get("aria-label"), "Image details");
  assert.deepEqual(h.values(), { Dimensions: "2048 × 1024 px", "File size": "1.5 KiB (1536 bytes)", Format: "JPEG" });
  assert.equal(h.container.children.some(child => child.tagName === "p"), false);
  assert.match(h.details().children.at(-1).title, /file extension/);
});

test("formats remain restricted to the existing image types, case insensitively", () => {
  const h = setup();
  for (const [extension, mime, label] of [
    ["PNG", "image/png", "PNG"], ["jpg", "image/jpeg", "JPEG"], ["jpeg", "image/jpeg", "JPEG"], ["svg", "image/svg+xml", "SVG"],
  ]) {
    const path = `images/example.${extension}`;
    assert.equal(h.imageType(path), mime);
    h.preview.show("x", path);
    h.image().onload();
    assert.equal(h.values().Format, label);
  }
  assert.equal(h.imageType("example.txt"), null);
  assert.equal(h.imageType("example.constructor"), null);
});

test("file size measures Blob bytes, including typed-array slices and UTF-8 strings", () => {
  const h = setup();
  for (const [bytes, expected] of [
    [new Uint8Array(0), "0 bytes"],
    [new Uint8Array(10).subarray(3, 4), "1 byte"],
    ["é", "2 bytes"],
    [new Uint8Array(1023), "1023 bytes"],
    [new Uint8Array(1024), "1.0 KiB (1024 bytes)"],
    [new Uint8Array(1024 * 1024), "1.0 MiB (1048576 bytes)"],
  ]) {
    h.preview.show(bytes, "image.png");
    h.image().onload();
    assert.equal(h.values()["File size"], expected);
  }
});

test("invalid images retain actionable errors and available metadata without invented dimensions", () => {
  const h = setup();
  h.preview.show(new Uint8Array(17), "broken.png");
  h.image().onerror();
  assert.equal(h.image().hidden, true);
  assert.equal(h.details().hidden, false);
  assert.match(h.container.children[1].textContent, /Unable to preview.*Download/);
  assert.deepEqual(h.values(), { Dimensions: "Unavailable", "File size": "17 bytes", Format: "PNG" });
  h.preview.show("<svg></svg>", "scalable.svg");
  h.image().onload();
  assert.equal(h.values().Dimensions, "Unavailable");
});

test("replacement and reset discard stale callbacks, clear sources and revoke each URL once", () => {
  const h = setup();
  h.preview.show("first", "first.png");
  const first = h.image();
  const lateLoad = first.onload;
  const lateError = first.onerror;
  h.preview.show("next", "next.jpg");
  assert.equal(first.onload, null);
  assert.equal(first.onerror, null);
  assert.equal(first.src, "");
  assert.deepEqual(h.revoked, ["blob:image-0"]);
  const second = h.image();
  lateLoad();
  lateError();
  assert.equal(second.hidden, true);
  assert.equal(h.details().hidden, true);
  assert.equal(h.values().Format, "JPEG");
  second.naturalWidth = 320;
  second.naturalHeight = 240;
  second.onload();
  const secondLateLoad = second.onload;
  const secondLateError = second.onerror;
  h.preview.reset();
  secondLateLoad();
  secondLateError();
  h.preview.reset();
  assert.equal(second.onload, null);
  assert.equal(second.onerror, null);
  assert.equal(second.src, "");
  assert.equal(h.container.hidden, true);
  assert.equal(h.container.children.length, 0);
  assert.deepEqual(h.revoked, ["blob:image-0", "blob:image-1"]);
});

test("rename changes accessible image text safely without reloading or discarding details", () => {
  const h = setup();
  h.preview.rename("before.png");
  h.preview.show("image", "original.png");
  const image = h.image();
  image.naturalWidth = 10;
  image.naturalHeight = 20;
  image.onload();
  const before = h.values();
  const path = '<img src=x onerror="alert(1)">.png';
  h.preview.rename(path);
  assert.equal(image.alt, path);
  assert.deepEqual(h.values(), before);
  assert.equal(h.created.length, 1);
  assert.equal(h.container.children.length, 2);
});
