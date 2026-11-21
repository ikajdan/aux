// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function load(path) {
  const result = await build({ entryPoints: [path], bundle: true, write: false, format: "esm", platform: "browser" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { makeAPI } = await load("src/gitlab-sync.ts");
const { restoreFocus } = await load("src/modal-dialogs.ts");

test("a null JSON error preserves the GitLab status and actionable message", async () => {
  const api = makeAPI(
    () => "test-token",
    async () => new Response("null", { status: 403 }),
  );
  await assert.rejects(api.request("user"), (error) => {
    assert.equal(error.status, 403);
    assert.equal(error.message, "GitLab 403: null");
    return true;
  });
});

test("focus restoration skips CSS-hidden elements and respects an open dialog", () => {
  const previousHTMLElement = globalThis.HTMLElement;
  const previousDocument = globalThis.document;
  class Element {
    isConnected = true;
    visible = true;
    focused = false;
    matches() {
      return false;
    }
    closest() {
      return null;
    }
    getClientRects() {
      return this.visible ? [{}] : [];
    }
    focus() {
      this.focused = true;
    }
  }
  try {
    globalThis.HTMLElement = Element;
    globalThis.document = { querySelectorAll: () => [] };
    const element = new Element();
    element.visible = false;
    restoreFocus(element);
    assert.equal(element.focused, false);
    element.visible = true;
    globalThis.document.querySelectorAll = () => [{ contains: () => false }];
    restoreFocus(element);
    assert.equal(element.focused, false);
    globalThis.document.querySelectorAll = () => [{ contains: (target) => target === element }];
    restoreFocus(element);
    assert.equal(element.focused, true, "focus can return inside the open dialog");
    element.focused = false;
    globalThis.document.querySelectorAll = () => [];
    restoreFocus(element);
    assert.equal(element.focused, true);
  } finally {
    if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousHTMLElement;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
