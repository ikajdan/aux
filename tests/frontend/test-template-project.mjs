// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({
  stdin: {
    contents: 'export { prepareTemplateProject, waitForTemplateProject } from "./src/projects/template-project.ts";',
    resolveDir: new URL("../../", import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});
const { prepareTemplateProject, waitForTemplateProject } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);

const templatePath = "team/templates/latex";
const metadataEndpoint = `projects/${encodeURIComponent(templatePath)}`;
const metadata = { id: 42, default_branch: "release/template", visibility: "public" };

function fixture(t, responses, endpoint = metadataEndpoint) {
  const calls = [];
  const unexpected = [];
  const api = {
    async request(...args) {
      calls.push(args);
      if (args[0] !== endpoint || args[1] !== undefined || responses.length === 0) {
        unexpected.push(args);
        throw new Error("Unexpected API request");
      }
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return structuredClone(response);
    },
  };
  t.after(() => {
    assert.deepEqual(unexpected, [], "Expected rejections must not hide unexpected API requests");
    assert.equal(responses.length, 0);
  });
  return { api, calls, config: { templateRepository: templatePath } };
}

test("template preparation reads only encoded project metadata and preserves visibility", async (t) => {
  for (const visibility of ["private", "internal", "public"]) {
    const f = fixture(t, [{ ...metadata, visibility }]);
    assert.deepEqual(await prepareTemplateProject(f.api, f.config), { id: 42, branch: "release/template", visibility });
    assert.deepEqual(
      f.calls.map(([endpoint]) => endpoint),
      [metadataEndpoint],
    );
  }
});

test("template preparation propagates access errors and rejects invalid metadata", async (t) => {
  const error = Object.assign(new Error("Template not accessible"), { status: 404 });
  const denied = fixture(t, [error]);
  await assert.rejects(prepareTemplateProject(denied.api, denied.config), (value) => value === error);
  for (const patch of [
    ...[undefined, null, 0, -1, 1.5, "42"].map((id) => ({ id })),
    ...[undefined, null, ""].map((default_branch) => ({ default_branch })),
    ...[undefined, null, "", "unknown"].map((visibility) => ({ visibility })),
  ]) {
    const f = fixture(t, [{ ...metadata, ...patch }]);
    await assert.rejects(prepareTemplateProject(f.api, f.config));
    assert.equal(f.calls.length, 1);
  }
});

test("polling returns a populated project only for absent, none or finished import status", async (t) => {
  for (const import_status of [undefined, "none", "finished"]) {
    const project = { ...metadata, empty_repo: false, import_status };
    const f = fixture(t, [project], "projects/42");
    assert.deepEqual(await waitForTemplateProject(f.api, 42, 0), project);
    assert.equal(f.calls.length, 1);
  }
});

test("polling always checks once at timeout zero but does not accept pending or empty projects", async (t) => {
  for (const patch of [{ import_status: "pending" }, { import_status: "started" }, { empty_repo: true }, { default_branch: null }, { default_branch: "" }]) {
    const f = fixture(t, [{ ...metadata, empty_repo: false, import_status: "finished", ...patch }], "projects/42");
    assert.equal(await waitForTemplateProject(f.api, 42, 0), null);
    assert.equal(f.calls.length, 1);
  }
});

for (const ready of [true, false]) {
  test(`polling retries until ${ready ? "the project is ready" : "the deadline, then stops"}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    const project = { ...metadata, empty_repo: false, import_status: "finished" };
    const f = fixture(
      t,
      [{ ...project, import_status: "pending" }, { ...project, import_status: "started" }, ready ? project : { ...project, import_status: "started" }],
      "projects/42",
    );
    const polling = waitForTemplateProject(f.api, 42, 1500);
    const advance = async (milliseconds) => {
      t.mock.timers.tick(milliseconds);
      await Promise.resolve();
      await Promise.resolve();
    };
    await advance(0);
    assert.equal(f.calls.length, 1);
    await advance(999);
    assert.equal(f.calls.length, 1);
    await advance(1);
    assert.equal(f.calls.length, 2);
    await advance(499);
    assert.equal(f.calls.length, 2);
    await advance(1);
    assert.deepEqual(await polling, ready ? project : null);
    assert.equal(f.calls.length, 3);
    await advance(10000);
    assert.equal(f.calls.length, 3, "settled polling must not schedule more requests");
  });
}

test("polling reports import failure with its detail or a generic error", async (t) => {
  for (const import_error of ["Fork import rejected", undefined]) {
    const f = fixture(t, [{ ...metadata, empty_repo: false, import_status: "failed", import_error }], "projects/42");
    await assert.rejects(waitForTemplateProject(f.api, 42, 0), import_error ? /Fork import rejected/ : /fail/i);
  }
  const error = new Error("Project lookup failed");
  const f = fixture(t, [error], "projects/42");
  await assert.rejects(waitForTemplateProject(f.api, 42, 0), (value) => value === error);
});
