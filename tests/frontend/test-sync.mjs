// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["src/gitlab-sync.ts"], bundle: true, write: false, format: "esm", platform: "browser" });
const { makeAPI, changedActions, encode64, decode64 } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const entry = (oid, bytes, mode = "100644") => ({ oid, bytes: Uint8Array.from(bytes), mode });

test("publication diff preserves binary content, deletions, executable changes, and unchanged files", () => {
  const base = {
    "keep.tex": entry("same", [1]),
    "remove.tex": entry("old", [2]),
    "image.png": entry("old-image", [0]),
    "run.sh": entry("script", [35, 33], "100755"),
  };
  const current = {
    "keep.tex": entry("same", [1]),
    "image.png": entry("new-image", [0, 128, 255]),
    "run.sh": entry("script", [35, 33]),
    "new.sh": entry("new-script", [10], "100755"),
  };
  const before = structuredClone({ base, current });
  assert.deepEqual(changedActions(base, current), [
    { action: "delete", file_path: "remove.tex" },
    { action: "update", file_path: "image.png", content: "AID/", encoding: "base64" },
    { action: "update", file_path: "run.sh", content: "IyE=", encoding: "base64" },
    { action: "chmod", file_path: "run.sh", execute_filemode: false },
    { action: "create", file_path: "new.sh", content: "Cg==", encoding: "base64" },
    { action: "chmod", file_path: "new.sh", execute_filemode: true },
  ]);
  assert.deepEqual({ base, current }, before, "building actions must not alter the baseline");
  assert.deepEqual(changedActions(base, base), []);
  assert.throws(() => changedActions({}, { link: entry("link", [1], "120000") }), /unsupported mode/);
});

test("binary encoding round-trips across the chunk boundary and accepts wrapped API base64", () => {
  const bytes = Uint8Array.from({ length: 20001 }, (_, i) => i % 256);
  const encoded = encode64(bytes);
  assert.equal(encoded, Buffer.from(bytes).toString("base64"));
  assert.deepEqual(decode64(encoded.match(/.{1,76}/g).join("\r\n")), bytes);
});

test("pagination retains query parameters and fetches beyond a full page without losing entries", async () => {
  const urls = [];
  const first = Array.from({ length: 100 }, (_, id) => ({ id }));
  const api = makeAPI(
    () => "token",
    async (url, options) => {
      urls.push(url);
      assert.equal(options.method, "GET");
      assert.equal(options.headers["PRIVATE-TOKEN"], "token");
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal instanceof AbortSignal);
      assert.ok(urls.length <= 2, "pagination must stop on the short page");
      return Response.json(urls.length === 1 ? first : [{ id: 100 }]);
    },
  );
  assert.deepEqual(await api.pages("projects?membership=true"), [...first, { id: 100 }]);
  assert.deepEqual(urls, ["/api/projects?membership=true&per_page=100&page=1", "/api/projects?membership=true&per_page=100&page=2"]);
});

test("an old credential's delayed failure cannot mark the replacement credential invalid", async () => {
  let token = "old";
  let complete;
  const statuses = [];
  const api = makeAPI(
    () => token,
    (_url, options) => {
      assert.equal(options.headers["PRIVATE-TOKEN"], "old");
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    (status) => statuses.push(status),
  );
  const request = api.request("user");
  token = "replacement";
  complete(Response.json({ message: "Unauthorized" }, { status: 401 }));
  await assert.rejects(request, { status: 401 });
  assert.deepEqual(statuses, []);
});

test("network errors remain actionable and observer failures cannot break successful requests", async () => {
  const failure = new Error("Network unavailable");
  const statuses = [];
  const offline = makeAPI(
    () => "token",
    async () => {
      throw failure;
    },
    (status) => statuses.push(status),
  );
  await assert.rejects(offline.request("user"), (error) => error === failure);
  assert.deepEqual(statuses, [0]);
  const api = makeAPI(
    () => "token",
    async (url, options) => {
      assert.equal(url, "/api/projects/1/repository/commits");
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { branch: "work" });
      return Response.json({ id: "commit" });
    },
    () => {
      throw new Error("UI observer failed");
    },
  );
  assert.deepEqual(await api.request("projects/1/repository/commits", { branch: "work" }), { id: "commit" });
  const brokenProxy = makeAPI(
    () => "token",
    async () => new Response("<html>Bad gateway</html>", { status: 502 }),
  );
  await assert.rejects(brokenProxy.request("user"), /non-JSON response.*502/);
});
