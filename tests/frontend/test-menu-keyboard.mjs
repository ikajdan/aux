// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/ui/menu-keyboard.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { handleMenuKeydown } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const key = (value, shiftKey = false) => ({ key: value, shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });

test("Tab and Shift+Tab dismiss menus without canceling native focus movement", () => {
  for (const shift of [false, true]) {
    let closed = false;
    const event = key("Tab", shift);
    handleMenuKeydown(event, [], null, () => { closed = true; });
    assert.equal(closed, true);
    assert.equal(event.defaultPrevented, false);
  }
});

test("Escape dismisses a menu and is handled without advancing focus", () => {
  let closed = false;
  const event = key("Escape");
  handleMenuKeydown(event, [], null, () => { closed = true; });
  assert.equal(closed, true);
  assert.equal(event.defaultPrevented, true);
});

test("menu arrows and Home/End focus the expected available action", () => {
  let focused;
  const items = Array.from({ length: 3 }, (_, index) => ({ focus(options) { focused = index; assert.equal(options.preventScroll, true); } }));
  for (const [name, active, expected] of [["ArrowDown", 0, 1], ["ArrowUp", 0, 2], ["Home", 2, 0], ["End", 0, 2], ["ArrowUp", -1, 2]]) {
    const event = key(name);
    handleMenuKeydown(event, items, items[active] || null, () => assert.fail("navigation must not close the menu"));
    assert.equal(focused, expected);
    assert.equal(event.defaultPrevented, true);
  }
  const event = key("ArrowDown");
  handleMenuKeydown(event, [], null, () => assert.fail("empty navigation must not close the menu"));
  assert.equal(event.defaultPrevented, false);
});
