// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function bundle(path) {
  const result = await build({ entryPoints: [path], bundle: true, write: false, format: "esm", platform: "node" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const configModule = await bundle("src/server-config.ts");
const modules = await bundle("src/gitlab-submodules.ts");

test("configuration is fetched without cache before becoming available", async (t) => {
  const config = { gitlabUrl: "https://git.example.com/gitlab", repositoryGroups: [{ name: "Docs", path: "team/docs" }] };
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/config");
    assert.equal(options.cache, "no-store");
    return { ok: true, json: async () => config };
  };
  await configModule.loadServerConfig();
  assert.deepEqual(configModule.serverConfig, config);
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(configModule.loadServerConfig(), /HTTP 503/);
});

test("submodule resolution requires an explicitly configured GitLab URL", () => {
  assert.throws(() => modules.resolveModule("team/docs", "../shared.git"), /GitLab URL has not been configured/);
  assert.throws(() => modules.resolveModule("team/docs", "https://git.example.com/team/shared.git"), /GitLab URL has not been configured/);
});

test("submodule resolution uses the configured instance and installation path", () => {
  modules.configureGitLab("https://git.example.com/gitlab");
  assert.equal(modules.resolveModule("team/docs", "../shared.git"), "team/shared");
  assert.equal(modules.resolveModule("team/docs", "https://git.example.com/gitlab/team/shared.git"), "team/shared");
  assert.throws(() => modules.resolveModule("team/docs", "https://foreign.example.com/gitlab/team/shared.git"), /configured GitLab/);
  assert.throws(() => modules.resolveModule("team/docs", "https://git.example.com/other/team/shared.git"), /configured GitLab/);
});
