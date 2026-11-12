// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/projects/project-topics.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { projectTopics, renderProjectTopics } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

test("topics come only from GitLab metadata, never inferred from a project name", () => {
  assert.deepEqual(projectTopics({ name: "sample-hardware-reference" }), []);
  assert.deepEqual(projectTopics({ topics: ["Guide", " guide ", "reference", "", null, 5] }), ["Guide", "reference"]);
  assert.deepEqual(projectTopics({ topics: "not-an-array" }), []);
});

test("topic rendering replaces stale topics and treats markup as text", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (tagName) => ({ tagName, children: [] }),
    },
  });
  t.after(() => (descriptor ? Object.defineProperty(globalThis, "document", descriptor) : delete globalThis.document));
  const container = {
    replaceChildren(...children) {
      this.children = children;
    },
  };
  renderProjectTopics(container, { topics: ["sbc", "datasheet"] });
  assert.deepEqual(
    container.children.map(({ textContent }) => textContent),
    ["sbc", "datasheet"],
  );

  renderProjectTopics(container, { topics: [] });
  assert.deepEqual(container.children, []);
  renderProjectTopics(container, { topics: ["<script>not markup</script>"] });
  assert.equal(container.children[0].textContent, "<script>not markup</script>");
});
