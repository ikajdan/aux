// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { webcrypto } from "node:crypto";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/random-id.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { randomId } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

test("random IDs use native randomUUID when available", () => {
  const source = { randomUUID() { assert.equal(this, source); return "native-id"; } };
  assert.equal(randomId(source), "native-id");
});

test("HTTP fallback generates distinct version 4 UUIDs using getRandomValues", () => {
  const source = { getRandomValues: (bytes) => webcrypto.getRandomValues(bytes) };
  const ids = Array.from({ length: 100 }, () => randomId(source));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
