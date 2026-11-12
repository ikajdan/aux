// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { transform } from "esbuild";

const source = await readFile("src/application.ts", "utf8");
function extract(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
const { code } = await transform(
  [
    extract("const publishingSuccess =", "const pendingMergeRequests ="),
    extract("function updateCommitControls()", "async function switchToPublishedBranch("),
    extract("async function push(", "const outputTabs ="),
  ].join("\n"),
  { loader: "ts" },
);

function element() {
  return {
    children: [],
    attributes: {},
    value: "",
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = children;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    querySelector() {
      return this.children.find((child) => child.className === "publishing-success") ?? null;
    },
  };
}
function fixture({ target = "main", fail = false, confirm = async () => true, storageFailure = false } = {}) {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  $("target").value = target;
  const state = { known: true, dirtyKnown: true, unpublished: true, dirty: false, draft: false };
  const events = [];
  const requests = [];
  const context = vm.createContext({
    $,
    busy: false,
    meta: { project: 1, dir: "/workspace", branch: "main", base: "base", remote: "remote", modes: {} },
    workspaces: {},
    project: { id: 1 },
    document: { createElement: element, createTextNode: (text) => ({ textContent: text }) },
    icon: (name) => ({ icon: name }),
    warningState: () => state,
    currentPublishingAvailability: () => ({ pushDisabled: !state.unpublished, mergeRequestDisabled: false, mergeRequestChecking: false }),
    pendingMergeRequest: () => undefined,
    mergeRequestTarget: () => "default",
    mergeRequestCheck: { dir: "/workspace", token: "", state: "open" },
    updateTargetBranches() {},
    resolveEditorDraft: async () => true,
    status: (message, state) => events.push({ type: "status", message, state }),
    confirmDialog: async (message, options) => {
      events.push({ type: "confirm", message, options });
      return confirm();
    },
    repo: {
      changes: async () => [],
      head: async () => "head",
      snapshot: async () => ({}),
      history: async () => [{ commit: { message: "Update document" } }],
    },
    changedActions: () => [{ action: "create", file_path: "main.tex", content: "", encoding: "base64" }],
    api: {
      request: async (endpoint) => {
        requests.push(endpoint);
        if (endpoint.endsWith("/repository/commits")) {
          if (fail) throw new Error("Push rejected");
          events.push({ type: "pushed" });
          return { id: "published" };
        }
        return { commit: { id: "remote" } };
      },
    },
    markWorkspace() {},
    persist(next) {
      if (storageFailure) throw new Error("Storage unavailable");
      events.push({ type: "persist", saved: JSON.parse(JSON.stringify(next)) });
    },
    refresh: async () => {
      state.unpublished = false;
      context.updatePushControls();
    },
    showPublishedBranch: async (branch) => {
      events.push({ type: "switch", branch });
      context.meta = { ...context.meta, dir: "/new-workspace", branch };
      state.unpublished = false;
      return true;
    },
  });
  vm.runInContext(code, context);
  const badge = () => $("push-heading").querySelector(".publishing-success");
  const commitBadge = () => $("commit-heading").querySelector(".publishing-success");
  return { context, state, badge, commitBadge, events, requests };
}

test("an existing MR has no completion badge until this session completes the MR action", () => {
  const f = fixture();
  f.context.updateMergeRequestControls();
  const heading = f.context.$("mr-heading");
  const badge = () => heading.querySelector(".publishing-success");
  assert.equal(badge().hidden, true);
  f.context.recordPublishingSuccess("opened");
  f.context.updateMergeRequestControls();
  assert.equal(badge().hidden, false);
  f.context.updateMergeRequestControls();
  assert.equal(badge().hidden, false);
  f.context.mergeRequestCheck.state = "none";
  f.context.updateMergeRequestControls();
  assert.equal(badge().hidden, true);
});

for (const target of ["main", "new-branch"]) {
  test(`successful push to ${target} shows a Done success badge`, async () => {
    const f = fixture({ target });
    f.context.updatePushControls();
    assert.equal(f.badge().hidden, true);
    await f.context.push();
    assert.equal(f.badge().hidden, false);
    f.state.unpublished = true;
    f.context.updatePushControls();
    assert.equal(f.badge().hidden, true);
  });
}

for (const target of ["main", "new-branch"]) {
  test(`commit and push Done badges remain visible together after pushing to ${target}`, async () => {
    const f = fixture({ target });
    f.context.recordPublishingSuccess("committed");
    f.context.updateCommitControls();
    assert.equal(f.commitBadge().hidden, false);
    await f.context.push();
    f.context.updateCommitControls();
    assert.equal(f.commitBadge().hidden, false);
    assert.equal(f.badge().hidden, false);
    f.context.updatePushControls();
    f.context.updateCommitControls();
    assert.equal(f.commitBadge().hidden, false);
    assert.equal(f.badge().hidden, false);
  });
}

test("switching after a push does not invent a commit Done badge if there was no commit in this session", async () => {
  const f = fixture({ target: "new-branch" });
  await f.context.push();
  assert.equal(f.commitBadge().hidden, true);
  assert.equal(f.badge().hidden, false);
});

for (const switchBranch of [false, true]) {
  test(`cross-branch publication survives serialization when ${switchBranch ? "switching" : "staying"}`, async () => {
    const f = fixture({ target: "feature", confirm: async () => switchBranch });
    await f.context.push();
    const saved = f.events.find((event) => event.type === "persist").saved;
    const restored = JSON.parse(JSON.stringify(saved))["1:main"];
    assert.deepEqual(restored.publication, { localHead: "head", branch: "feature", remoteCommit: "published" });
    assert.equal(restored.base, "base");
    assert.equal(restored.remote, "remote");
    const steps = f.events.map((event) => event.type);
    assert.ok(steps.indexOf("pushed") < steps.indexOf("persist"));
    assert.ok(steps.indexOf("persist") < steps.indexOf("confirm"));
  });
}

test("publication persistence failure reports remote success without mutating the baseline or switching", async () => {
  const f = fixture({ storageFailure: true });
  const previous = f.context.meta;
  await assert.rejects(f.context.push(), /Commits were pushed to main, but saving their local publication status failed/);
  assert.equal(f.context.meta, previous);
  assert.equal(f.context.meta.base, "base");
  assert.equal(f.context.meta.remote, "remote");
  assert.equal(
    f.events.some((event) => event.type === "switch"),
    false,
  );
});

test("failed pushes do not show the success badge", async () => {
  const f = fixture({ target: "feature", fail: true });
  await assert.rejects(f.context.push(), /Push rejected/);
  f.context.updatePushControls();
  assert.equal(f.badge().hidden, true);
  assert.equal(
    f.events.some((event) => event.type === "confirm"),
    false,
  );
});

for (const target of ["main", "master"]) {
  test(`pushing to ${target} requires confirmation before any GitLab request`, async () => {
    let answer;
    const gate = new Promise((resolve) => {
      answer = resolve;
    });
    const f = fixture({ target, confirm: () => gate });
    f.context.meta.branch = target;
    const pushing = f.context.push();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.requests, []);
    assert.equal(
      f.events.some((event) => event.type === "status" && event.state === "busy"),
      false,
    );
    const prompt = f.events.find((event) => event.type === "confirm");
    assert.equal(prompt.options.destructive, true);
    answer(true);
    await pushing;
    const progress = f.events.find((event) => event.type === "status" && event.state === "busy");
    assert.ok(f.events.indexOf(progress) > f.events.indexOf(prompt));
    assert.equal(
      f.events.some((event) => event.type === "pushed"),
      true,
    );
  });

  test(`canceling a push to ${target} preserves the workspace and sends no GitLab request`, async () => {
    const f = fixture({ target, confirm: async () => false });
    const previous = f.context.meta;
    assert.equal(await f.context.push(), false);
    assert.deepEqual(f.requests, []);
    assert.equal(f.context.meta, previous);
    assert.equal(
      f.events.some((event) => event.type === "status" && event.state === "busy"),
      false,
    );
    assert.equal(
      f.events.some((event) => event.type === "persist" || event.type === "pushed"),
      false,
    );
  });
}

test("pushing to another branch waits for confirmation before loading it", async () => {
  let proceed;
  const answer = new Promise((resolve) => {
    proceed = resolve;
  });
  const f = fixture({ target: "feature", confirm: () => answer });
  const pushing = f.context.push();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.context.meta.branch, "main");
  assert.equal(
    f.events.some((event) => event.type === "pushed"),
    true,
  );
  assert.equal(
    f.events.some((event) => event.type === "switch"),
    false,
  );
  const dialog = f.events.find((event) => event.type === "confirm");
  proceed(true);
  await pushing;
  assert.equal(f.context.meta.branch, "feature");
  assert.equal(f.events.filter((event) => event.type === "switch").length, 1);
});

test("declining the switch keeps the current workspace after a successful push", async () => {
  const f = fixture({ target: "feature", confirm: async () => false });
  const result = await f.context.push();
  assert.equal(result.statusHandled, true);
  assert.equal(f.context.meta.branch, "main");
  assert.equal(f.context.meta.base, "base");
  assert.equal(f.context.meta.remote, "remote");
  assert.equal(
    f.events.some((event) => event.type === "pushed"),
    true,
  );
  assert.equal(
    f.events.some((event) => event.type === "switch"),
    false,
  );
});

test("pushing to the current branch does not ask to switch", async () => {
  const f = fixture();
  await f.context.push();
  assert.equal(
    f.events.some((event) => event.type === "confirm" && event.options.confirmLabel === "Switch branch"),
    false,
  );
  assert.equal(f.context.meta.remote, "published");
});
