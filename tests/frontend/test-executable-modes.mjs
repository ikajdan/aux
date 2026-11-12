// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/git-repository.ts", "src/gitlab-sync.ts"],
  bundle: true,
  write: false,
  outdir: "out",
  format: "esm",
  platform: "browser",
});
const load = async (name) =>
  import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles.find((file) => file.path.endsWith(name)).text).toString("base64")}`);
const { Repository } = await load("git-repository.js");
const { changedActions } = await load("gitlab-sync.js");
const author = { name: "Mode test", email: "mode@example.invalid" };

async function fixture(t, links = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aux-modes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const modes = { "bin/run.sh": "100755", "bin/nested/helper.sh": "100755", "bin/readme.txt": "100644", "binary.sh": "100644" };
  const repo = new Repository(fs, dir, links, modes);
  await repo.init();
  for (const name of Object.keys(modes)) await repo.write(name, `contents: ${name}\n`);
  const base = await repo.commit("Import", author);
  return { dir, modes, repo, base };
}

for (const withLinks of [false, true]) {
  test(`import, file/directory rename, reload and publication preserve executable modes${withLinks ? " with gitlinks" : ""}`, async (t) => {
    const links = withLinks ? [{ path: "vendor", oid: "1234567890123456789012345678901234567890" }] : [];
    const { dir, modes, repo, base } = await fixture(t, links);
    assert.equal((await repo.snapshot(base))["bin/run.sh"].mode, "100755");
    await repo.rename("bin/run.sh", "bin/renamed.sh");
    assert.equal(modes["bin/run.sh"], undefined);
    assert.equal(modes["bin/renamed.sh"], "100755");
    await repo.rename("bin", "tools/scripts");
    assert.equal(modes["bin/nested/helper.sh"], undefined);
    assert.equal(modes["tools/scripts/nested/helper.sh"], "100755");
    assert.equal(modes["binary.sh"], "100644", "directory prefix must match a whole path segment");
    const restored = new Repository(fs, dir, links, JSON.parse(JSON.stringify(modes)));
    const head = await restored.commit("Rename", author);
    const current = await restored.snapshot(head);
    assert.equal(current["tools/scripts/renamed.sh"].mode, "100755");
    assert.equal(current["tools/scripts/nested/helper.sh"].mode, "100755");
    assert.equal(current["tools/scripts/readme.txt"].mode, "100644");
    const actions = changedActions(await restored.snapshot(base), current);
    for (const name of ["tools/scripts/renamed.sh", "tools/scripts/nested/helper.sh"]) {
      assert.ok(actions.some((action) => action.action === "create" && action.file_path === name));
      assert.ok(actions.some((action) => action.action === "chmod" && action.file_path === name && action.execute_filemode === true));
    }
    assert.ok(actions.some((action) => action.action === "delete" && action.file_path === "bin/run.sh"));
    assert.ok(!actions.some((action) => action.file_path === "vendor"));
  });
}

test("imported symlinks preserve their target and mode without phantom changes or publication actions", async (t) => {
  const { repo, dir, modes } = await fixture(t);
  await repo.write(".latexmkrc", "tools/latexmkrc");
  await repo.write("tools/latexmkrc", "$pdf_mode = 5;\n");
  modes[".latexmkrc"] = "120000";
  const base = await repo.commit("Import symlink", author);
  const before = await repo.snapshot(base);
  assert.equal(before[".latexmkrc"].mode, "120000");
  assert.equal(new TextDecoder().decode(before[".latexmkrc"].bytes), "tools/latexmkrc");
  assert.deepEqual(await repo.changes(), []);
  await assert.rejects(repo.write(".latexmkrc", "changed"), /Symbolic links are read-only/);
  await assert.rejects(repo.rename(".latexmkrc", "latexmkrc"), /Symbolic links are read-only/);
  await assert.rejects(repo.deletePath(".latexmkrc"), /Symbolic links are read-only/);
  await repo.write("tools/latexmkrc", "$pdf_mode = 4; # updated target\n");
  const restored = new Repository(fs, dir, [], JSON.parse(JSON.stringify(modes)));
  const head = await restored.commit("Edit target", author);
  const current = await restored.snapshot(head);
  assert.equal(current[".latexmkrc"].mode, "120000");
  assert.equal(current[".latexmkrc"].oid, before[".latexmkrc"].oid);
  assert.deepEqual(
    changedActions(before, current).map((action) => action.file_path),
    ["tools/latexmkrc"],
  );
  assert.deepEqual(await restored.changes(), []);
});

test("unpublished commit counts use the baseline and are not capped by the 30-entry history display", async (t) => {
  const { repo, base } = await fixture(t);
  assert.equal(await repo.unpublishedCommitCount(base), 0);
  for (let i = 1; i <= 32; i++) {
    await repo.write("binary.sh", `revision ${i}\n`);
    await repo.commit(`Change ${i}`, author);
  }
  assert.equal((await repo.history()).length, 30);
  assert.equal(await repo.unpublishedCommitCount(base), 32);
  assert.equal(await repo.unpublishedCommitCount(await repo.head()), 0);
  await assert.rejects(repo.unpublishedCommitCount("0".repeat(40)), /baseline is not in local commit history/);
});

test("failed and no-op renames leave imported modes untouched", async (t) => {
  const { repo, modes } = await fixture(t);
  const before = { ...modes };
  await repo.rename("bin", "bin");
  await assert.rejects(repo.rename("bin/run.sh", "bin/readme.txt"), /Destination already exists/);
  await assert.rejects(repo.rename("bin", "bin/nested/new"), /into itself/);
  const rename = repo.p.rename;
  repo.p = Object.assign(Object.create(repo.p), {
    rename: async () => {
      throw new Error("Injected rename failure");
    },
  });
  await assert.rejects(repo.rename("bin", "new/target"), /Injected rename failure/);
  repo.p.rename = rename;
  assert.deepEqual(modes, before);
  await assert.rejects(fs.promises.stat(`${repo.dir}/new`), { code: "ENOENT" });
});
