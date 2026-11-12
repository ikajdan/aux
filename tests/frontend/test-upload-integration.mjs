// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { build, transform } from "esbuild";

const source = await readFile(new URL("../../src/application.ts", import.meta.url), "utf8");
const start = source.indexOf("async function uploadFiles(");
const end = source.indexOf('for (const id of ["uploads", "folder-uploads"])', start);
assert.ok(start >= 0 && end > start, "Extract the actual application uploadFiles function");
const { code } = await transform(source.slice(start, end), { loader: "ts", target: "es2022" });
const bundled = await build({
  stdin: {
    contents:
      'export { safePath } from "./src/gitlab-sync.ts"; export { uniqueUploadPath } from "./src/workspace/upload-conflicts.ts"; export { validateSnapshotSizes } from "./src/workspace/snapshot-limits.ts";',
    resolveDir: new URL("../..", import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const helpers = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const choice = (action, applyToRemaining = false) => ({ action, applyToRemaining });
const fsError = (code, path) => Object.assign(new Error(`${code}: ${path}`), { code });

function fixture({ initial = {}, directories = [], choices = [], limits = {}, file = null, draftAllowed = true, failWrite, statError } = {}) {
  const contents = new Map(Object.entries(initial));
  const dirs = new Set(directories);
  const writes = [];
  const reads = [];
  const prompts = [];
  const events = [];
  const writable = [];
  const answers = [...choices];
  const parents = (path) =>
    path
      .split("/")
      .slice(0, -1)
      .map((_, i, parts) => parts.slice(0, i + 1).join("/"));
  const isDirectory = (path) => dirs.has(path) || [...contents.keys(), ...dirs].some((entry) => entry.startsWith(`${path}/`));
  const context = vm.createContext({
    ...helpers,
    Uint8Array,
    workspaceReady: true,
    file,
    selectedTreePath: "original-selection",
    serverConfig: { limits: { snapshotFiles: 100, snapshotBytes: 10000, ...limits } },
    repo: {
      dir: "/workspace",
      assertWritable(path) {
        helpers.safePath(path);
        writable.push(path);
      },
      async files() {
        return [...contents.keys()];
      },
      p: {
        async stat(absolute) {
          assert.ok(absolute.startsWith("/workspace/"));
          const path = absolute.slice("/workspace/".length);
          if (statError?.path === path) throw statError.error;
          if (parents(path).some((parent) => contents.has(parent))) throw fsError("ENOTDIR", path);
          if (contents.has(path)) return { size: Buffer.byteLength(contents.get(path)), isDirectory: () => false };
          if (isDirectory(path)) return { size: 0, isDirectory: () => true };
          throw fsError("ENOENT", path);
        },
      },
      async write(path, bytes) {
        events.push(`write:${path}`);
        if (failWrite === path) throw new Error(`Write failed: ${path}`);
        if (parents(path).some((parent) => contents.has(parent))) throw fsError("ENOTDIR", path);
        if (isDirectory(path)) throw fsError("EISDIR", path);
        const text = Buffer.from(bytes).toString();
        contents.set(path, text);
        writes.push([path, text]);
      },
    },
    async uploadConflictDialog(path) {
      prompts.push(path);
      events.push(`prompt:${path}`);
      assert.ok(answers.length, `Unexpected conflict prompt for ${path}`);
      return answers.shift();
    },
    async resolveEditorDraft() {
      events.push("draft");
      return draftAllowed;
    },
    markWorkspace() {
      events.push("mark");
    },
    async refresh() {
      events.push("refresh");
      context.selectedTreePath = "refresh-selection";
    },
    async openFile(path) {
      events.push(`open:${path}`);
      context.selectedTreePath = "open-selection";
    },
    expandTreePath(path) {
      events.push(`expand:${path}`);
    },
    syncTree() {
      events.push(`sync:${context.selectedTreePath}`);
    },
  });
  vm.runInContext(code, context, { filename: "upload-integration.js" });
  return {
    context,
    contents,
    writes,
    reads,
    prompts,
    events,
    writable,
    answers,
    upload: (...args) => context.uploadFiles(...args),
    source(name, text = "new", relativePath = name) {
      return {
        name,
        size: Buffer.byteLength(text),
        webkitRelativePath: relativePath,
        async arrayBuffer() {
          reads.push(name);
          events.push(`read:${name}`);
          return Uint8Array.from(Buffer.from(text)).buffer;
        },
      };
    },
  };
}

for (const action of ["replace", "skip", "keep-both"]) {
  test(`conflict ${action} changes only the chosen destination`, async () => {
    const f = fixture({ initial: { "main.tex": "old", "untouched.tex": "untouched" }, choices: [choice(action)] });
    assert.equal(await f.upload([f.source("main.tex")], ""), action !== "skip");
    assert.deepEqual(f.prompts, ["main.tex"]);
    assert.equal(f.contents.get("untouched.tex"), "untouched");
    assert.equal(f.contents.get("main.tex"), action === "replace" ? "new" : "old");
    assert.deepEqual(f.writes, action === "skip" ? [] : [[action === "keep-both" ? "main (2).tex" : "main.tex", "new"]]);
    assert.deepEqual(f.reads, action === "skip" ? [] : ["main.tex"]);
    assert.equal(f.events.filter((event) => event === "refresh").length, action === "skip" ? 0 : 1);
  });

  test(`apply remaining ${action} covers conflicts only and resets for the next batch`, async () => {
    const f = fixture({
      initial: { "a.tex": "old-a", "b.tex": "old-b" },
      choices: [choice(action, true), choice("skip"), choice("replace")],
    });
    await f.upload([f.source("a.tex", "A"), f.source("fresh.tex", "F"), f.source("b.tex", "B")], "");
    assert.deepEqual(f.prompts, ["a.tex"]);
    assert.equal(f.contents.get("fresh.tex"), "F", "Non-conflicting files must not inherit skip/keep-both");
    const targetA = action === "keep-both" ? "a (2).tex" : "a.tex";
    const targetB = action === "keep-both" ? "b (2).tex" : "b.tex";
    assert.equal(f.contents.get(targetA), action === "skip" ? "old-a" : "A");
    assert.equal(f.contents.get(targetB), action === "skip" ? "old-b" : "B");

    const before = f.writes.length;
    assert.equal(await f.upload([f.source("a.tex", "second-A"), f.source("b.tex", "second-B")], ""), true);
    assert.deepEqual(f.prompts, ["a.tex", "a.tex", "b.tex"], "A new batch must ask again; unchecked skip must not persist");
    assert.deepEqual(f.writes.slice(before), [["b.tex", "second-B"]]);
    assert.deepEqual(f.answers, []);
  });
}

test("cancel discards the whole plan before reading or writing any upload bytes", async () => {
  const f = fixture({ initial: { "a.tex": "old-a", "b.tex": "old-b" }, choices: [choice("replace"), null] });
  assert.equal(await f.upload([f.source("fresh.tex"), f.source("a.tex"), f.source("b.tex")], ""), false);
  assert.deepEqual(f.prompts, ["a.tex", "b.tex"]);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(
    [...f.contents],
    [
      ["a.tex", "old-a"],
      ["b.tex", "old-b"],
    ],
  );
  assert.ok(!f.events.includes("mark") && !f.events.includes("refresh"));
});

for (const reverse of [false, true]) {
  test(`keep both avoids future incoming names, existing files and directories (reverse=${reverse})`, async () => {
    const f = fixture({
      initial: { "docs/main.tex": "old", "docs/main (3).tex": "existing" },
      directories: ["docs/main (4).tex"],
      choices: [choice("keep-both")],
    });
    const files = [f.source("main.tex", "renamed"), f.source("main (2).tex", "incoming")];
    if (reverse) files.reverse();
    assert.equal(await f.upload(files, "docs"), true);
    assert.equal(f.contents.get("docs/main.tex"), "old");
    assert.equal(f.contents.get("docs/main (2).tex"), "incoming");
    assert.equal(f.contents.get("docs/main (3).tex"), "existing");
    assert.equal(f.contents.get("docs/main (5).tex"), "renamed");
    assert.ok(f.writable.includes("docs/main (5).tex"), "Allocated names are checked for writability");
  });
}

test("duplicate incoming paths see prior planned files before any writes", async () => {
  const f = fixture({ choices: [choice("keep-both", true)] });
  assert.equal(await f.upload([f.source("a.tex", "one"), f.source("a.tex", "two"), f.source("a.tex", "three")], ""), true);
  assert.deepEqual(f.writes, [
    ["a.tex", "one"],
    ["a (2).tex", "two"],
    ["a (3).tex", "three"],
  ]);
  assert.deepEqual(f.prompts, ["a.tex"]);
  assert.ok(f.events.indexOf("prompt:a.tex") < f.events.indexOf("read:a.tex"));
});

for (const [limits, message] of [
  [{ snapshotFiles: 1 }, /file limit/],
  [{ snapshotBytes: 5 }, /size limit/],
]) {
  test(`keep both counts the original and added file against ${JSON.stringify(limits)}`, async () => {
    const f = fixture({ initial: { "main.tex": "old" }, choices: [choice("keep-both")], limits });
    await assert.rejects(f.upload([f.source("main.tex", "new")], ""), message);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.reads, []);
    assert.equal(f.contents.get("main.tex"), "old");
    assert.ok(!f.events.includes("refresh"));
  });
}

test("keep both accepts exact snapshot byte and file boundaries", async () => {
  const f = fixture({ initial: { "main.tex": "old" }, choices: [choice("keep-both")], limits: { snapshotFiles: 2, snapshotBytes: 6 } });
  assert.equal(await f.upload([f.source("main.tex", "new")], ""), true);
  assert.deepEqual(f.writes, [["main (2).tex", "new"]]);
});

test("replace uses the final size, while skip excludes incoming bytes from limits", async () => {
  const f = fixture({
    initial: { "a.tex": "123456789", "b.tex": "B" },
    choices: [choice("replace"), choice("skip")],
    limits: { snapshotFiles: 2, snapshotBytes: 4 },
  });
  assert.equal(await f.upload([f.source("a.tex", "123"), f.source("b.tex", "too large to include")], ""), true);
  assert.deepEqual(f.writes, [["a.tex", "123"]]);
});

for (const action of ["replace", "skip", "keep-both"]) {
  test(`refresh/reopen and selection restoration when the open file is ${action}`, async () => {
    const f = fixture({ initial: { "docs/main.tex": "old" }, file: "docs/main.tex", choices: [choice(action)] });
    assert.equal(await f.upload([f.source("main.tex")], "docs"), action !== "skip");
    assert.equal(f.events[0], "prompt:docs/main.tex");
    assert.deepEqual(
      f.events.filter((event) => event === "draft"),
      action === "replace" ? ["draft"] : [],
    );
    if (action === "replace") {
      assert.ok(f.events.indexOf("draft") < f.events.indexOf("read:main.tex"), "Resolve the draft before reading or writing uploads");
    }
    assert.deepEqual(
      f.events.filter((event) => event.startsWith("open:")),
      action === "replace" ? ["open:docs/main.tex"] : [],
    );
    if (action !== "skip") {
      assert.deepEqual(f.events.slice(-(action === "replace" ? 4 : 3)), [
        "refresh",
        ...(action === "replace" ? ["open:docs/main.tex"] : []),
        "expand:docs",
        "sync:original-selection",
      ]);
      assert.equal(f.context.selectedTreePath, "original-selection");
    } else {
      assert.ok(!f.events.includes("refresh"));
    }
  });
}

test("refresh after unrelated writes does not reopen the active file", async () => {
  const f = fixture({ initial: { "open.tex": "old" }, file: "open.tex" });
  assert.equal(await f.upload([f.source("new.tex")], ""), true);
  assert.deepEqual(f.events.slice(-2), ["refresh", "sync:original-selection"]);
  assert.ok(!f.events.some((event) => event.startsWith("open:") || event.startsWith("expand:") || event === "draft"));
});

test("partial write failure still refreshes, reopens a replaced file, and restores selection", async () => {
  const f = fixture({ initial: { "main.tex": "old" }, file: "main.tex", choices: [choice("replace")], failWrite: "broken.tex" });
  await assert.rejects(f.upload([f.source("main.tex"), f.source("broken.tex")], ""), /Write failed/);
  assert.deepEqual(f.writes, [["main.tex", "new"]]);
  assert.deepEqual(f.events.slice(-3), ["refresh", "open:main.tex", "sync:original-selection"]);
});

test("failure of the first write does not refresh or reopen", async () => {
  const f = fixture({ failWrite: "broken.tex" });
  await assert.rejects(f.upload([f.source("broken.tex")], ""), /Write failed/);
  assert.deepEqual(f.writes, []);
  assert.ok(!f.events.includes("refresh"));
});

test("declining the draft guard aborts after planning but before any upload reads or writes", async () => {
  const f = fixture({ initial: { "main.tex": "old" }, file: "main.tex", choices: [choice("replace")], draftAllowed: false });
  assert.equal(await f.upload([f.source("fresh.tex"), f.source("main.tex")], ""), false);
  assert.deepEqual(f.events, ["prompt:main.tex", "draft"]);
  assert.deepEqual(f.prompts, ["main.tex"]);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.writes, []);
});

for (const action of ["skip", "keep-both", "cancel"]) {
  test(`${action} preserves the active draft without invoking its guard or reopening the file`, async () => {
    const f = fixture({
      initial: { "main.tex": "old" },
      file: "main.tex",
      choices: [action === "cancel" ? null : choice(action)],
      draftAllowed: false,
    });
    // Represent the dirty editor at the mocked UI boundary. Any guard/reopen
    // would save, discard, or replace it and must be observable in this test.
    const draft = { dirty: true, text: "unsaved editor contents" };
    f.context.resolveEditorDraft = async () => {
      draft.dirty = false;
      assert.fail("Must not resolve the active draft");
    };
    f.context.openFile = async () => {
      draft.text = "reloaded";
      assert.fail("Must not reopen the active file");
    };
    assert.equal(await f.upload([f.source("fresh.tex"), f.source("main.tex")], ""), action !== "cancel");
    assert.deepEqual(draft, { dirty: true, text: "unsaved editor contents" });
    assert.equal(f.contents.get("main.tex"), "old");
    assert.deepEqual(f.writes, action === "cancel" ? [] : [["fresh.tex", "new"], ...(action === "keep-both" ? [["main (2).tex", "new"]] : [])]);
    if (action === "cancel") assert.deepEqual(f.reads, []);
  });
}

test("cancelling a later conflict preserves the draft even after choosing to replace the active file", async () => {
  const f = fixture({
    initial: { "main.tex": "old", "other.tex": "other" },
    file: "main.tex",
    choices: [choice("replace"), null],
  });
  assert.equal(await f.upload([f.source("main.tex"), f.source("other.tex")], ""), false);
  assert.deepEqual(f.events, ["prompt:main.tex", "prompt:other.tex"]);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.writes, []);
  assert.equal(f.contents.get("main.tex"), "old");
});

test("snapshot validation rejects an active-file replacement before resolving its draft", async () => {
  const f = fixture({
    initial: { "main.tex": "old" },
    file: "main.tex",
    choices: [choice("replace")],
    limits: { snapshotBytes: 3 },
  });
  await assert.rejects(f.upload([f.source("main.tex", "too large")], ""), /size limit/);
  assert.deepEqual(f.events, ["prompt:main.tex"]);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.writes, []);
  assert.equal(f.contents.get("main.tex"), "old");
});

for (const reverse of [false, true]) {
  test(`planned file/folder collisions abort before draft resolution or writes (reverse=${reverse})`, async () => {
    const f = fixture({ initial: { "main.tex": "old" }, file: "main.tex", choices: [choice("replace")] });
    const collision = [f.source("folder", "file"), f.source("child.tex", "child", "folder/child.tex")];
    if (reverse) collision.reverse();
    await assert.rejects(
      f.upload([f.source("main.tex"), ...collision], "", (file) => file.webkitRelativePath),
      /Cannot upload both a file and a folder at folder/,
    );
    assert.deepEqual(f.events, ["prompt:main.tex"]);
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.writes, []);
    assert.equal(f.contents.get("main.tex"), "old");
  });
}

test("folder uploads use relative paths and reject directory conflicts before any writes", async () => {
  const f = fixture({ directories: ["docs/folder/main.tex"] });
  await assert.rejects(
    f.upload([f.source("fresh.tex", "fresh", "folder/fresh.tex"), f.source("main.tex", "new", "folder/main.tex")], "docs", (file) => file.webkitRelativePath),
    /A folder already exists/,
  );
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.prompts, []);
});

test("unexpected existence errors propagate instead of overwriting a candidate", async () => {
  const error = fsError("EIO", "main (2).tex");
  const f = fixture({ initial: { "main.tex": "old" }, choices: [choice("keep-both")], statError: { path: "main (2).tex", error } });
  await assert.rejects(f.upload([f.source("main.tex")], ""), (caught) => caught === error);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.reads, []);
});

test("empty uploads do not refresh or write", async () => {
  const f = fixture();
  assert.equal(await f.upload([], ""), false);
  assert.deepEqual(f.events, []);
});

test("keep both must not allocate the parent of another incoming file", async () => {
  const f = fixture({ initial: { "main.tex": "old" }, choices: [choice("keep-both")] });
  assert.equal(
    await f.upload([f.source("main.tex", "renamed"), f.source("child.tex", "child", "main (2).tex/child.tex")], "", (file) => file.webkitRelativePath),
    true,
  );
  assert.deepEqual(f.writes, [
    ["main (3).tex", "renamed"],
    ["main (2).tex/child.tex", "child"],
  ]);
});
