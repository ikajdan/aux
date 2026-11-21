// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/projects/catalog.ts"], bundle: true, write: false, platform: "node", format: "cjs",
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const project = (id) => ({ id, path_with_namespace: `team/project${id}` });
function fixture() {
  const module = { exports: {} };
  const intervals = [], writes = [], refreshing = [], tags = [];
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, console, URL,
    setInterval: (...args) => intervals.push(args),
  });
  let token = "token", settings = {};
  const refresh = { dataset: {}, setAttribute() {} };
  const options = {
    initialProjects: [],
    config: { gitlabUrl: "https://gitlab.example", repositoryGroups: [{ name: "Team", path: "team" }] },
    api: { pages: async () => [], request: async () => [] },
    view: {
      showLatestTag: (p) => tags.push(p), updateRepositoryTimes() {},
      setRefreshing: (value) => refreshing.push(value), installRefreshGuards() {}, render() {},
    },
    elements: { refresh, customRepositories: {}, customRepositoriesStatus: {} },
    getToken: () => token, getSettings: () => settings, setSettings: (next) => { settings = next; },
    storage: { setItem: (...args) => writes.push(args) }, readStorage: () => null,
    status() {}, dismissStatus() {}, getStatusVersion: () => 0,
  };
  return { options, create: () => module.exports.createCatalogController(options), intervals, writes, refreshing, tags,
    setToken: (value) => { token = value; } };
}

test("only the latest refresh owns catalog publication and busy cleanup", async () => {
  const f = fixture(), older = deferred(), newer = deferred();
  let calls = 0;
  f.options.api.pages = () => (++calls === 1 ? older.promise : newer.promise);
  const c = f.create();
  const first = c.refreshDocuments(), second = c.refreshDocuments();
  older.resolve([project(1)]);
  await first;
  assert.equal(c.isRefreshing, true);
  assert.equal(c.projects.length, 0);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.refreshing, [true, true]);
  newer.resolve([project(2)]);
  await second;
  assert.equal(c.projects[0].id, 2);
  assert.equal(c.isRefreshing, false);
  assert.deepEqual(f.refreshing, [true, true, false]);
});

test("changing the live token discards a pending refresh", async () => {
  const f = fixture(), pending = deferred();
  f.options.api.pages = () => pending.promise;
  const c = f.create(), refresh = c.refreshDocuments();
  f.setToken("replacement");
  pending.resolve([project(1)]);
  await refresh;
  assert.equal(c.projects.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(c.isRefreshing, false);
});

test("superseded tag workers drain before the next four-request pool starts", async () => {
  const f = fixture(), requests = [];
  let active = 0, maximum = 0;
  f.options.api.pages = async () => Array.from({ length: 6 }, (_, i) => project(i));
  f.options.api.request = () => {
    const d = deferred();
    requests.push(d);
    maximum = Math.max(maximum, ++active);
    return d.promise.finally(() => { active--; });
  };
  const c = f.create(), first = c.refreshDocuments();
  await tick();
  assert.equal(requests.length, 4);
  const second = c.refreshDocuments();
  await tick();
  assert.equal(requests.length, 4);
  requests.slice(0, 4).forEach((d) => d.resolve([{ name: "old" }]));
  await first;
  await tick();
  assert.equal(f.tags.length, 0);
  assert.equal(requests.length, 8);
  requests.slice(4, 8).forEach((d) => d.resolve([{ name: "new" }]));
  await tick();
  requests.slice(8).forEach((d) => d.resolve([{ name: "new" }]));
  await second;
  assert.equal(maximum, 4);
  assert.equal(f.tags.length, 6);
});

test("construction defers UI installation and replacement is assignment-only", () => {
  const f = fixture(), c = f.create();
  assert.equal(f.intervals.length, 0);
  const paths = ["other/project"];
  c.replaceCustomRepositories(paths);
  assert.equal(c.customRepositories, paths);
  assert.equal(f.writes.length, 0);
  assert.equal(c.isRefreshing, false);
  c.installUI();
  c.installUI();
  assert.equal(f.intervals.length, 1);
  assert.equal(f.intervals[0][1], 60000);
});
