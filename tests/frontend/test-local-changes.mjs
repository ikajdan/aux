// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["src/workspace/local-changes.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { localChangeBranches } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const clean = { dirty: false, dirtyKnown: true, unpublished: false, known: true, pending: 0, errors: new Set() };

test("local changes include edits, unpublished commits, pending and failed saves in one branch list", () => {
  const entries = [
    ["edits", { dirty: true }],
    ["commits", { unpublished: true }],
    ["both", { dirty: true, unpublished: true }],
    ["saving", { pending: 1 }],
    ["failed", { errors: new Set(["main.tex"]) }],
    ["draft", { draft: true }],
    ["clean", {}],
  ];
  const workspaces = entries.map(([branch]) => ({ project: 1, branch, dir: branch }));
  const warnings = new Map(entries.map(([branch, state]) => [branch, { ...clean, ...state }]));
  assert.deepEqual(localChangeBranches("1", workspaces, warnings), ["edits", "commits", "both", "saving", "failed", "draft"]);
});

test("unknown states and other projects are excluded; duplicate branch names are merged", () => {
  const workspaces = [
    { project: 1, branch: "main", dir: "one" },
    { project: 1, branch: "main", dir: "two" },
    { project: 2, branch: "other", dir: "other" },
    { project: 1, branch: "unknown", dir: "unknown" },
    { project: 1, branch: "missing", dir: "missing" },
  ];
  const warnings = new Map([
    ["one", { ...clean, dirty: true }],
    ["two", { ...clean, unpublished: true }],
    ["other", { ...clean, dirty: true }],
    ["unknown", { ...clean, dirty: true, dirtyKnown: false, unpublished: true, known: false }],
  ]);
  assert.deepEqual(localChangeBranches(1, workspaces, warnings), ["main"]);
  assert.deepEqual(localChangeBranches(3, workspaces, warnings), []);
});
