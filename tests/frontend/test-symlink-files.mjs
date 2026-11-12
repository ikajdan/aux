// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({ entryPoints: [new URL("../../src/workspace/symlink-files.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "browser" });
const { materializeSymlinkFiles } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const limits = { snapshotFiles: 100, snapshotBytes: 10000 };
const file = (path, content = "data", mode = "100644") => ({ path, bytes: typeof content === "string" ? new TextEncoder().encode(content) : content, mode });
const link = (path, target) => file(path, target, "120000");
const materialize = (files, overrides = {}) => materializeSymlinkFiles(files, { ...limits, ...overrides });
const paths = (files) => files.map(({ path }) => path);
const contents = (files) => Object.fromEntries(files.map(({ path, bytes }) => [path, new TextDecoder().decode(bytes)]));

test("ordinary bytes and executable/submodule modes are preserved as plain files without mutating inputs", () => {
  const binary = Uint8Array.of(0, 255, 128, 195, 40);
  const files = [file("vendor/lib/run", binary, "100755"), file("empty", new Uint8Array()), file("main.tex")];
  const before = structuredClone(files);
  const result = materialize(files);
  assert.deepEqual(result, [files[1], files[2], files[0]].map(({ path, bytes }) => ({ path, bytes })));
  assert.deepEqual(files, before);
  assert.strictEqual(result[2].bytes, binary);
  assert.deepEqual(materialize([]), []);
});

test("root build configuration links and link chains resolve to ordinary file bytes", () => {
  const files = [
    link(".latexmkrc", "tools/latexmkrc"), link("Makefile", "./tools/Makefile"),
    file("tools/latexmkrc", "latex configuration"), file("tools/Makefile", "build rules", "100755"),
    link("config", ".latexmkrc"), link("nested/config", "../config"),
  ];
  const result = contents(materialize(files));
  assert.equal(result[".latexmkrc"], "latex configuration");
  assert.equal(result.Makefile, "build rules");
  assert.equal(result["nested/config"], "latex configuration");
  assert.deepEqual(materialize(files), materialize([...files].reverse()));
});

test("directory links duplicate descendants, including nested links and intermediate directory aliases", () => {
  const result = contents(materialize([
    file("source/deep/a", "A"), file("source/b", "B"), link("source/deep/b", "../b"),
    link("alias", "source"), link("chain", "alias"), link("selected", "chain/deep/b"),
    link("nested/copied", "../alias/deep"),
  ]));
  assert.equal(result["alias/deep/a"], "A");
  assert.equal(result["alias/deep/b"], "B");
  assert.equal(result["chain/deep/b"], "B");
  assert.equal(result.selected, "B");
  assert.equal(result["nested/copied/a"], "A");
  assert.equal(Object.keys(result).length, 12);
});

test("relative targets can cross materialized submodules in both directions", () => {
  const result = contents(materialize([
    file("shared/config", "root"), file("vendor/one/data", "module", "100755"),
    link("vendor/two/config", "../../shared/config"), link("vendor/two/data", "../one/data"),
    link("root-data", "vendor/two/data"), link("all", "vendor/one"),
  ]));
  assert.equal(result["vendor/two/config"], "root");
  assert.equal(result["vendor/two/data"], "module");
  assert.equal(result["root-data"], "module");
  assert.equal(result["all/data"], "module");
});

test("parent traversal follows intermediate directory links before applying dot-dot", () => {
  const result = contents(materialize([
    file("real/deep/file", "deep"), file("real/peer", "physical parent"), file("peer", "lexical parent"),
    link("alias", "real/deep"), link("selected", "alias/../peer"),
    link("repeated", "alias/../../alias/file"),
  ]));
  assert.equal(result.selected, "physical parent");
  assert.equal(result.repeated, "deep");
});

for (const target of ["", "/etc/passwd", "//host/file", "C:/file", "C:relative", "dir\\file", "a\0b", ".git/config", "dir/.git/config", "dir/.GIT/config", "../outside", "dir/../../outside"]) {
  test(`rejects unsafe target ${JSON.stringify(target)} with the link path`, () => {
    assert.throws(() => materialize([file("dir/file"), link("unsafe-link", target)]), (error) => {
      assert.match(error.message, /unsafe-link/);
      assert.match(error.message, /unsafe|escapes/);
      return true;
    });
  });
}

test("rejects invalid UTF-8 rather than replacing target bytes", () => {
  assert.throws(() => materialize([link("bad-encoding", Uint8Array.of(195, 40))]), /bad-encoding.*UTF-8/);
});

test("target names are not trimmed, URL-decoded, or stripped of a UTF-8 BOM", () => {
  const result = contents(materialize([
    file(" space \n", "spaces"), link("spaces", " space \n"),
    file("%2e%2e", "literal percent"), link("percent", "%2e%2e"),
    file("\ufeffname", "BOM"), link("bom", "\ufeffname"),
  ]));
  assert.equal(result.spaces, "spaces");
  assert.equal(result.percent, "literal percent");
  assert.equal(result.bom, "BOM");
});

test("dangling links and targets that traverse ordinary files report actionable paths", () => {
  assert.throws(() => materialize([link("broken", "missing")]), /broken.*dangling.*missing/);
  assert.throws(() => materialize([file("plain"), link("broken", "plain/child")]), /broken.*ordinary file.*plain/);
  assert.throws(() => materialize([file("plain"), link("broken", "plain/..")]), /broken.*ordinary file/);
  assert.throws(() => materialize([link("alias", "missing"), link("broken", "alias/file")]), /alias.*dangling.*missing/);
});

for (const [name, files] of [
  ["self", [link("loop", "loop")]],
  ["chain", [link("a", "b"), link("b", "a")]],
  ["intermediate", [link("a", "b/child"), link("b", "a")]],
  ["directory ancestor", [file("dir/file"), link("dir/up", "..")]],
  ["directory self", [file("dir/file"), link("dir/self", ".")]],
  ["directory pair", [file("one/file"), file("two/file"), link("one/other", "../two"), link("two/other", "../one")]],
]) {
  test(`rejects ${name} cycles`, () => assert.throws(() => materialize(files), /cycle/));
}

test("bounds final materialized file count and byte size, including directory copies", () => {
  const files = [file("source/a", "1234"), file("source/b", "12"), link("copy", "source")];
  assert.equal(materialize(files, { snapshotFiles: 4, snapshotBytes: 12 }).length, 4);
  assert.throws(() => materialize(files, { snapshotFiles: 3 }), /3-file limit/);
  assert.throws(() => materialize(files, { snapshotBytes: 11 }), /11-byte size limit/);
  assert.throws(() => materialize([file("empty", "")], { snapshotFiles: 0 }), /0-file limit/);
  assert.throws(() => materialize([file("large", "123")], { snapshotBytes: 2 }), /2-byte size limit/);
  assert.equal(materialize([file("a", "x"), link("b", "./././a")], { snapshotBytes: 2 }).length, 2);
});

test("bounds multiplicative directory expansion", () => {
  const files = [file("level0/data", "x")];
  for (let level = 1; level <= 12; level++) {
    files.push(link(`level${level}/a`, `../level${level - 1}`), link(`level${level}/b`, `../level${level - 1}`));
  }
  assert.throws(() => materialize(files, { snapshotFiles: 20 }), /20-file limit/);
});

test("rejects ambiguous or unsafe input paths rather than overwriting output", () => {
  for (const path of ["", "/root", "a/../b", "a/./b", "a//b", "a\\b", ".git/config", "a\0b"]) {
    assert.throws(() => materialize([file(path)]), /invalid project file path/);
  }
  assert.throws(() => materialize([file("same"), file("same")]), /conflicting/);
  for (const files of [[file("a"), file("a/b")], [file("a/b"), link("a", "elsewhere")]]) {
    assert.throws(() => materialize(files), /conflict/);
  }
});
