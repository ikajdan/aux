// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundled = await build({
  entryPoints: ["src/projects/new-project.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [
    {
      name: "new-project-boundaries",
      setup(build) {
        build.onResolve({ filter: /(?:select-control|modal-dialogs|template-project)\.js$/ }, (args) => ({ path: args.path, namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({
          contents: path.endsWith("select-control.js")
            ? `export function createSelect(element) { return { setValue(value) { element.value = value; }, rebuild() {}, sync() {} }; }`
            : path.endsWith("modal-dialogs.js")
              ? `export async function promptDialog() { throw new Error("Unexpected namespace prompt"); } export function restoreFocus(button) { button.focus(); }`
              : `export function prepareTemplateProject(...args) { return globalThis.__newProjectPrepare(...args); } export function waitForTemplateProject(...args) { return globalThis.__newProjectWait(...args); }`,
        }));
      },
    },
  ],
});
const { initializeNewProject } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);

const template = {
  visibility: "internal",
  branch: "documents",
  id: 42,
};
const remoteProject = { id: 73, path_with_namespace: "team/docs/new-document", default_branch: "documents", empty_repo: false };

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Only the DOM surface used by this dialog is needed; events still invoke its real handlers.
function element() {
  const listeners = new Map();
  return {
    value: "",
    textContent: "",
    hidden: false,
    disabled: false,
    open: false,
    dataset: {},
    options: [],
    attributes: {},
    validity: { valid: true },
    append(option) {
      this.options.push(option);
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatch(type) {
      return listeners.get(type)?.({ preventDefault() {} });
    },
    setAttribute(key, value) {
      this.attributes[key] = value;
    },
    removeAttribute(key) {
      delete this.attributes[key];
    },
    focus() {},
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      this.dispatch("close");
    },
    click() {
      return this.onclick?.();
    },
  };
}

function harness(t, steps, prepare = async () => structuredClone(template), wait = async () => structuredClone(remoteProject)) {
  const ids = [
    "new-project",
    "new-project-card",
    "new-project-dialog",
    "new-project-form",
    "new-project-name",
    "new-project-path",
    "new-project-namespace",
    "create-project",
    "new-project-close",
    "new-project-status",
    "new-project-result",
    "new-project-title-action",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, element()]));
  const get = (id) => elements[id];
  get("new-project-namespace").append({ value: "", textContent: "My namespace" });
  get("new-project-form").reset = () => {
    for (const id of ["new-project-name", "new-project-path", "new-project-namespace"]) get(id).value = "";
  };
  const previousDocument = globalThis.document;
  const previousPrepare = globalThis.__newProjectPrepare;
  const previousWait = globalThis.__newProjectWait;
  globalThis.document = { getElementById: get, createElement: () => element() };
  const calls = [],
    unexpected = [],
    events = [],
    persisted = [];
  let token = "first-private-token";
  globalThis.__newProjectPrepare = async (...args) => {
    events.push("prepare");
    return prepare(...args);
  };
  globalThis.__newProjectWait = async (...args) => {
    events.push("wait");
    assert.equal(args[0], api);
    assert.equal(args[1], remoteProject.id);
    return wait(...args);
  };
  const api = {
    async request(endpoint, payload) {
      calls.push({ endpoint, payload });
      events.push(endpoint);
      const step = steps.shift();
      if (!step || step.endpoint !== endpoint) {
        unexpected.push(endpoint);
        throw new Error("Unexpected API request");
      }
      if (step.error) throw step.error;
      return step.result;
    },
  };
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.__newProjectPrepare = previousPrepare;
    globalThis.__newProjectWait = previousWait;
    assert.deepEqual(unexpected, [], "unexpected API requests must not be swallowed by UI error handling");
    assert.equal(steps.length, 0, "all expected API requests were made");
  });
  initializeNewProject({
    api,
    config: { gitlabUrl: "https://gitlab.example", templateRepository: "templates/base", repositoryGroups: [{ name: "Documents", path: "team/docs" }] },
    getToken: () => token,
    onCreated(project) {
      events.push("persist");
      persisted.push(structuredClone(project));
    },
    async onReady() {
      events.push("refresh");
    },
  });
  return {
    get,
    calls,
    events,
    persisted,
    setToken(value) {
      token = value;
    },
    async open() {
      await get("new-project").click();
    },
    fill(destination = "") {
      get("new-project-name").value = "New document";
      get("new-project-path").value = "new-document";
      get("new-project-namespace").value = destination;
      get("new-project-namespace").onchange();
    },
    submit() {
      return get("new-project-form").onsubmit({ preventDefault() {} });
    },
  };
}
const user = () => ({ endpoint: "user", result: { username: "alice" } });
const forkEndpoint = "projects/42/fork";
const create = () => ({ endpoint: forkEndpoint, result: { ...remoteProject } });

test("creation forks with template visibility and destination, persists before waiting and refreshes only when ready", async (t) => {
  const ready = deferred();
  const started = deferred();
  const h = harness(
    t,
    [user(), { endpoint: "groups/team%2Fdocs", result: { id: 42 } }, create()],
    undefined,
    async () => {
      started.resolve();
      return ready.promise;
    },
  );
  await h.open();
  h.fill("team/docs");
  const submission = h.submit();
  await started.promise;
  assert.deepEqual(h.events, ["user", "prepare", "groups/team%2Fdocs", forkEndpoint, "persist", "wait"]);
  assert.deepEqual(h.persisted, [remoteProject]);
  assert.equal(h.get("create-project").disabled, true);
  await h.submit();
  assert.deepEqual(h.calls.find((call) => call.endpoint === forkEndpoint).payload, {
    name: "New document",
    path: "new-document",
    visibility: "internal",
    namespace_id: 42,
  });
  ready.resolve({ ...remoteProject });
  await submission;
  assert.deepEqual(h.events, ["user", "prepare", "groups/team%2Fdocs", forkEndpoint, "persist", "wait", "refresh"]);
  assert.equal(h.get("new-project-result").href, "https://gitlab.example/team/docs/new-document");
  assert.equal(h.get("new-project-result").hidden, false);
  await h.submit();
  assert.equal(h.calls.filter((call) => call.endpoint === forkEndpoint).length, 1);
});

test("failed template preparation never creates a remote project", async (t) => {
  const h = harness(t, [user()], async () => {
    throw new Error("Template lookup failed");
  });
  await h.open();
  h.fill("team/docs");
  await h.submit();
  assert.deepEqual(
    h.calls.map((call) => call.endpoint),
    ["user"],
  );
  assert.match(h.get("new-project-status").textContent, /Template lookup failed/);
  assert.equal(h.get("create-project").disabled, false);
  assert.equal(h.get("new-project-result").hidden, true);
  assert.deepEqual(h.persisted, []);
  assert.equal(h.events.includes("refresh"), false);
});

test("failed readiness wait retains the created link, blocks duplicate submission and does not signal readiness", async (t) => {
  const h = harness(t, [user(), create()], undefined, async () => {
    throw new Error("Fork import rejected");
  });
  await h.open();
  h.fill();
  await h.submit();
  assert.equal(h.get("new-project-result").hidden, false);
  assert.equal(h.get("new-project-result").href, "https://gitlab.example/team/docs/new-document");
  assert.match(h.get("new-project-status").textContent, /project was created, but setup could not finish.*Fork import rejected/);
  assert.equal(h.get("create-project").disabled, true);
  const calls = h.calls.length;
  await h.submit();
  assert.equal(h.calls.length, calls);
  assert.deepEqual(h.persisted, [remoteProject]);
  assert.equal(h.events.includes("refresh"), false);
  assert.equal(h.calls[1].payload.namespace_id, undefined);
});

test("pending fork retains its link and persistence without refresh or retry", async (t) => {
  const h = harness(t, [user(), create()], undefined, async () => null);
  await h.open();
  h.fill();
  await h.submit();
  assert.deepEqual(h.events, ["user", "prepare", forkEndpoint, "persist", "wait"]);
  assert.deepEqual(h.persisted, [remoteProject]);
  assert.equal(h.get("new-project-result").hidden, false);
  assert.equal(h.get("new-project-result").href, "https://gitlab.example/team/docs/new-document");
  assert.match(h.get("new-project-status").textContent, /pending|still|progress/i);
  assert.equal(h.get("create-project").disabled, true);
  assert.equal(h.calls[1].payload.namespace_id, undefined);
  await h.submit();
  assert.equal(h.calls.length, 2);
});

for (const [label, error] of [
  ["network timeout", new Error("Request timed out")],
  ["server failure", Object.assign(new Error("Gateway timeout"), { status: 504 })],
]) {
  test(`uncertain creation after ${label} exposes the predicted link and prevents retry`, async (t) => {
    const h = harness(t, [user(), { endpoint: forkEndpoint, error }]);
    await h.open();
    h.fill();
    await h.submit();
    assert.equal(h.get("new-project-result").hidden, false);
    assert.equal(h.get("new-project-result").href, "https://gitlab.example/alice/new-document");
    assert.match(h.get("new-project-status").textContent, /may have created the project/);
    assert.equal(h.get("create-project").disabled, true);
    await h.submit();
    assert.deepEqual(
      h.calls.map((call) => call.endpoint),
      ["user", forkEndpoint],
    );
    assert.deepEqual(h.persisted, []);
    assert.equal(h.events.includes("refresh"), false);
  });
}

test("username lookup is cached across opens and invalidated when the PAT changes without exposing secrets", async (t) => {
  const h = harness(t, [user(), { endpoint: "user", result: { username: "bob" } }]);
  await h.open();
  assert.equal(h.get("new-project-namespace").options[0].textContent, "alice");
  h.get("new-project-dialog").close();
  await h.open();
  assert.equal(h.calls.length, 1);
  assert.equal(h.get("new-project-namespace").options[0].textContent, "alice");
  h.get("new-project-dialog").close();
  h.setToken("replacement-private-token");
  await h.open();
  assert.deepEqual(
    h.calls.map((call) => call.endpoint),
    ["user", "user"],
  );
  assert.equal(h.get("new-project-namespace").options[0].textContent, "bob");
  const visible = [h.get("new-project-status").textContent, ...h.get("new-project-namespace").options.map((option) => option.textContent)].join(" ");
  assert.equal(visible.includes("private-token"), false);
});

test("name input generates a normalized path and editing the path updates the name", async (t) => {
  const h = harness(t, [user()]);
  await h.open();
  h.get("new-project-name").value = "  Résumé & Notes!  ";
  h.get("new-project-name").dispatch("input");
  assert.equal(h.get("new-project-path").value, "resume-notes");
  h.get("new-project-path").value = "manual-path";
  h.get("new-project-path").dispatch("input");
  assert.equal(h.get("new-project-name").value, "manual-path");
});
