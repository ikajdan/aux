// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../../src/modal-dialogs.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { installInputConfirmation } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

function fixture(tagName = "INPUT") {
  const input = Object.assign(new EventTarget(), { tagName, disabled: false });
  let clicks = 0;
  const button = { disabled: false, dataset: {}, getAttribute: () => null, click: () => clicks++ };
  installInputConfirmation(input, button);
  return {
    input,
    button,
    clicks: () => clicks,
    key(properties = {}) {
      const event = new Event("keydown", { cancelable: true });
      Object.assign(event, { key: "Enter", ...properties });
      input.dispatchEvent(event);
      return event;
    },
  };
}

const pairs = [["message", "commit"], ["target", "push"], ["mr-title", "create-mr"]];

test("Enter clicks only the corresponding action and prevents implicit submission", () => {
  const fields = pairs.map(() => fixture());
  for (const [index, field] of fields.entries()) {
    assert.equal(field.key().defaultPrevented, true);
    assert.deepEqual(fields.map((item) => item.clicks()), fields.map((_, i) => Number(i <= index)));
  }
});

for (const state of ["disabled", "loading", "busy", "input-disabled", "repeat"]) {
  test(`Enter does not activate ${state} actions but still prevents submission`, () => {
    const field = fixture();
    if (state === "disabled") field.button.disabled = true;
    if (state === "loading") field.button.dataset.loading = "true";
    if (state === "busy") field.button.getAttribute = () => "true";
    if (state === "input-disabled") field.input.disabled = true;
    assert.equal(field.key({ repeat: state === "repeat" }).defaultPrevented, true);
    assert.equal(field.clicks(), 0);
  });
}

for (const properties of [{ key: "Escape" }, { isComposing: true }, { keyCode: 229 }]) {
  test(`non-confirming key remains untouched: ${JSON.stringify(properties)}`, () => {
    const field = fixture();
    assert.equal(field.key(properties).defaultPrevented, false);
    assert.equal(field.clicks(), 0);
  });
}

test("textarea Enter preserves multiline editing", () => {
  const field = fixture("TEXTAREA");
  assert.equal(field.key().defaultPrevented, false);
  assert.equal(field.clicks(), 0);
});

test("already-handled Enter does not activate an action", () => {
  const input = Object.assign(new EventTarget(), { tagName: "INPUT" });
  input.addEventListener("keydown", (event) => event.preventDefault());
  installInputConfirmation(input, { click: () => assert.fail("unexpected confirmation") });
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { key: "Enter" });
  input.dispatchEvent(event);
});
