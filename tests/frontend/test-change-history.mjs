// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/workspace/change-history.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { renderHistory } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.textContent = "";
  }
  setAttribute(name, value) {
    this[name === "class" ? "className" : name] = value;
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
}
function fixture(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tag) => new Element(tag), createElementNS: (_namespace, tag) => new Element(tag) },
  });
  t.after(() => (descriptor ? Object.defineProperty(globalThis, "document", descriptor) : delete globalThis.document));
  return new Element("div");
}
const find = (root, name) => root.children.flatMap((node) => [...((node.className || "").split(" ").includes(name) ? [node] : []), ...find(node, name)]);
const timestamp = new Date(2026, 9, 18, 22, 13, 27).getTime() / 1000;
const commit = (oid, message) => ({ oid, commit: { message, author: { name: "Test Author", timestamp } } });

test("history shows commit messages and status without import, branch, author, or timestamp details", (t) => {
  const container = fixture(t);
  renderHistory(
    container,
    { branch: "main", base: "import" },
    [["main.tex", 1, 2, 1]],
    [commit("new", "Add test commit\n\nDetailed explanation"), commit("import", `Pull main @ ${"a".repeat(40)}`)],
  );
  assert.deepEqual(
    find(container, "history-heading-label").map((node) => node.textContent),
    ["Changes", "Commits"],
  );
  assert.deepEqual(
    find(container, "history-count").map((node) => node.textContent),
    ["1", "1"],
  );
  for (const heading of find(container, "history-title")) assert.equal(find(heading, "icon").length, 1);
  assert.equal(find(container, "history-context").length, 0);
  const [heading] = find(container, "history-commit-heading");
  assert.equal(find(heading, "history-message")[0].textContent, "Add test commit");
  assert.equal(find(heading, "history-unpublished")[0].textContent, "Unpublished");
  assert.equal(find(container, "history-body")[0].textContent, "Detailed explanation");
  assert.equal(find(container, "history-time").length, 0);
  assert.equal(find(container, "history-author").length, 0);
  assert.equal(find(container, "history-meta").length, 0);
});

test("reloaded publication receipts distinguish published changes from newer unpublished commits", (t) => {
  const container = fixture(t);
  const restored = JSON.parse(
    JSON.stringify({
      branch: "main",
      base: "import",
      publication: { localHead: "pushed", branch: "feature", remoteCommit: "remote-feature" },
    }),
  );
  renderHistory(
    container,
    restored,
    [],
    [commit("new", "Next change"), commit("pushed", "Test commit"), commit("older", "Earlier change"), commit("import", `Pull main @ ${"a".repeat(40)}`)],
  );
  const headings = find(container, "history-commit-heading");
  assert.equal(find(headings[0], "history-unpublished").length, 1);
  for (const heading of headings.slice(1)) {
    assert.equal(find(heading, "history-unpublished").length, 0);
    assert.equal(find(heading, "history-badge")[0].textContent, "Published to feature");
  }
});

test("published commits have no unpublished badge and import-only history has no empty commit section", (t) => {
  const container = fixture(t);
  renderHistory(container, { branch: "main", base: "published" }, [], [commit("published", "Published commit")]);
  assert.equal(find(container, "history-unpublished").length, 0);
  renderHistory(container, { branch: "main", base: "import" }, [], [commit("import", `Pull main @ ${"a".repeat(40)}`)]);
  assert.deepEqual(
    find(container, "history-heading-label").map((node) => node.textContent),
    ["Changes"],
  );
  assert.equal(find(container, "history-commit").length, 0);
});
