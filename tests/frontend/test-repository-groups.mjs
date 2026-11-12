// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/projects/repository-groups.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { groupRepositories, repositoryGroupFor, fetchGroupRepositories } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);
const groups = [
  { name: "Manuals", path: "team/manuals/documentation" },
  { name: "Guides", path: "team/guides/documentation" },
];
const project = (id, group, suffix = "doc") => ({ id, path_with_namespace: `${group}/${suffix}` });

test("projects are grouped in config order while retaining sort order within each group", () => {
  const a = project(1, groups[0].path, "a");
  const b = project(2, groups[0].path, "sub/b");
  const g = project(3, groups[1].path);
  const buckets = groupRepositories([g, b, a], groups);
  assert.deepEqual(
    buckets.map(({ group }) => group.name),
    ["Manuals", "Guides"],
  );
  assert.deepEqual(
    buckets.map(({ projects }) => projects.map(({ id }) => id)),
    [[2, 1], [3]],
  );
  assert.deepEqual(
    groupRepositories([], groups).map(({ projects }) => projects),
    [[], []],
  );
});

test("overlapping groups use deepest namespace and deduplicate numeric/string IDs", () => {
  const nested = [...groups, { name: "Nested", path: `${groups[0].path}/nested` }];
  const p = project(1, nested[2].path);
  assert.equal(repositoryGroupFor(p, nested), nested[2]);
  assert.deepEqual(
    groupRepositories([p, { ...p, id: "1" }], nested).map(({ projects }) => projects.length),
    [0, 0, 1],
  );
  assert.equal(repositoryGroupFor(project(2, `${groups[0].path}-other`), nested), undefined);
  assert.equal(repositoryGroupFor({ id: 3 }, nested), undefined);
});

test("refresh fetches every encoded group path, including subgroups, and deduplicates results", async () => {
  const endpoints = [];
  const a = project(1, groups[0].path);
  const g = project(2, groups[1].path);
  const projects = await fetchGroupRepositories(async (endpoint) => {
    endpoints.push(endpoint);
    return endpoint.includes("manuals") ? [a] : [g, a];
  }, groups);
  assert.deepEqual(
    projects.map(({ id }) => id),
    [1, 2],
  );
  assert.equal(endpoints.length, 2);
  assert.ok(endpoints[0].startsWith("groups/team%2Fmanuals%2Fdocumentation/projects?"));
  for (const endpoint of endpoints) assert.match(endpoint, /include_subgroups=true&with_shared=false/);
});

test("fresh project metadata keeps GitLab topics when grouping and deduplicating", async () => {
  const remote = { ...project(1, groups[0].path), topics: ["hardware", "datasheet"] };
  const projects = await fetchGroupRepositories(async () => [remote], groups);
  assert.deepEqual(projects, [remote]);
  assert.deepEqual(groupRepositories(projects, groups)[0].projects[0].topics, ["hardware", "datasheet"]);
});

test("a failed group fetch rejects the combined refresh rather than returning a partial catalog", async () => {
  await assert.rejects(
    fetchGroupRepositories(async (endpoint) => {
      if (endpoint.includes("guides")) throw new Error("Forbidden");
      return [project(1, groups[0].path)];
    }, groups),
    /Forbidden/,
  );
});
