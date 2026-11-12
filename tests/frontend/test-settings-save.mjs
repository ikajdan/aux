// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { build, transform } from "esbuild";

const source = await readFile("src/application.ts", "utf8");
const start = source.indexOf("async function saveAllSettings()");
const end = source.indexOf("const openSetup =", start);
assert.ok(start >= 0 && end > start);
const { code } = await transform(source.slice(start, end), { loader: "ts" });

function fixture({ invalid = false, failed = false, repositoryFeedback = "" } = {}) {
  const elements = Object.fromEntries(
    ["connection-form", "save-settings", "restore-settings", "custom-repositories-status", "token", "author", "email"].map((id) => [
      id,
      {
        textContent: "",
        disabled: false,
        hasAttribute: () => id === "email" && invalid,
      },
    ]),
  );
  const statuses = [];
  const saves = [];
  const focused = [];
  const runs = [];
  let repositorySaves = 0;
  let pending;
  const context = vm.createContext({
    $: (id) => elements[id],
    busy: false,
    settingsKeys: ["token", "author", "email"],
    failedSettings: new Set(failed ? ["token"] : []),
    saveSettingsFields: (validate) => saves.push(validate),
    settingsStatus: (...args) => statuses.push(args),
    restoreFocus: (input) => focused.push(input),
    saveCustomRepositories: async () => {
      repositorySaves++;
      elements["custom-repositories-status"].textContent = repositoryFeedback;
    },
    run: (...args) => {
      runs.push(args);
      pending = Promise.resolve().then(args[0]);
      return pending;
    },
  });
  vm.runInContext(code, context);
  return {
    elements,
    statuses,
    saves,
    focused,
    runs,
    context,
    get repositorySaves() {
      return repositorySaves;
    },
    get pending() {
      return pending;
    },
    save: () => context.saveAllSettings(),
  };
}

test("Settings has one form-linked Save button in a persistent footer", async () => {
  const html = await readFile("src/application.html", "utf8");
  assert.doesNotMatch(html, /id="save-(?:connection|identity|repositories)"|settings-section-actions/);
  const footer = html.match(/<footer class="settings-footer">([\s\S]*?)<\/footer>/)?.[1];
  assert.ok(footer, "Settings has a persistent footer");
  assert.match(footer, /^\s*<div class="settings-feedback">/);
  assert.match(
    footer,
    /<button id="restore-settings" type="button"[^>]*>Restore changes<\/button>\s*<button id="save-settings" class="primary" type="submit" form="connection-form">Save settings<\/button>\s*$/,
  );
  assert.equal((html.match(/id="save-settings"/g) || []).length, 1);
  assert.match(
    html,
    /class="settings-feedback">\s*<p class="settings-storage-hint hint">[^<]+<\/p>\s*<p id="connection-status"[^>]*><\/p>\s*<p id="custom-repositories-status"/,
  );
  assert.match(html, /<button id="restore-settings" type="button"[^>]*>Restore changes<\/button>/);
  const css = await readFile("src/styles/global-ui.css", "utf8");
  assert.match(css, /#connection-dialog > \.settings-footer\s*\{[^}]*flex-shrink: 0;[^}]*border-top:/);
  assert.match(css, /#connection-dialog \.settings-feedback > p\s*\{\s*margin: 0;/);
});

test("Save validates all fields and saves repositories with one success message", async () => {
  const f = fixture();
  await f.save();
  assert.deepEqual(f.saves, [true]);
  assert.equal(f.repositorySaves, 1);
  assert.deepEqual(f.statuses, [[""], ["Settings saved."]]);
});

test("repository refresh feedback is not duplicated by a second success message", async () => {
  const f = fixture({ repositoryFeedback: "Saved. Documents refreshed." });
  await f.save();
  assert.deepEqual(f.statuses, [[""]]);
  assert.equal(f.elements["custom-repositories-status"].textContent, "Saved. Documents refreshed.");
});

test("invalid fields focus their inline error and do not save repositories", async () => {
  const f = fixture({ invalid: true });
  assert.equal(await f.save(), false);
  assert.equal(f.repositorySaves, 0);
  assert.deepEqual(f.focused, [f.elements.email]);
  assert.deepEqual(f.statuses, [["Check the highlighted fields.", "error"]]);
});

test("storage failures do not show success or continue to repositories", async () => {
  const f = fixture({ failed: true });
  assert.equal(await f.save(), false);
  assert.equal(f.repositorySaves, 0);
  assert.deepEqual(f.statuses, []);
});

test("submitting uses the guarded operation and prevents repeated clicks", async () => {
  const f = fixture();
  let prevented = 0;
  const event = {
    preventDefault() {
      prevented++;
    },
  };
  f.elements["connection-form"].onsubmit(event);
  assert.equal(f.elements["save-settings"].disabled, true);
  assert.equal(f.elements["restore-settings"].disabled, true);
  f.elements["connection-form"].onsubmit(event);
  assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0][1], "Save settings");
  assert.equal(f.runs[0][4].allowSaveFailure, true);
  await f.pending;
  await Promise.resolve();
  assert.equal(f.elements["save-settings"].disabled, false);
  assert.equal(f.elements["restore-settings"].disabled, false);
  assert.equal(prevented, 2);
});

test("a busy workspace does not submit another settings operation", () => {
  const f = fixture();
  f.context.busy = true;
  f.elements["connection-form"].onsubmit({ preventDefault() {} });
  assert.equal(f.runs.length, 0);
  assert.equal(f.elements["save-settings"].disabled, false);
});

const setupBundle = await build({ entryPoints: ["src/ui/setup.ts"], bundle: true, write: false, format: "iife", globalName: "setupUI", platform: "browser" });

function setupFixture({ validateToken = async () => ({ id: 1 }), saveField = () => true, persistTheme = () => {} } = {}) {
  const events = [];
  class Element extends EventTarget {
    dataset = {};
    attributes = new Map();
    value = "";
    validity = { valid: true };
    isConnected = true;
    disabled = false;
    setAttribute(key, value) {
      this.attributes.set(key, value);
    }
    removeAttribute(key) {
      this.attributes.delete(key);
    }
    hasAttribute(key) {
      return this.attributes.has(key);
    }
    getBoundingClientRect() {
      return { height: 100 };
    }
    getClientRects() {
      return [{}];
    }
    matches() {
      return this.disabled;
    }
    closest() {
      return null;
    }
    focus() {
      events.push("focus");
    }
    querySelector() {
      return new Element();
    }
    querySelectorAll() {
      return [];
    }
  }
  const elements = Object.fromEntries(
    [
      "setup-dialog",
      "setup-token",
      "setup-token-error",
      "setup-status",
      "setup-form",
      "setup-next",
      "setup-next-label",
      "setup-close",
      "app-menu",
      ...["token", "author", "email"].flatMap((key) => [key, `setup-${key}`, `setup-${key}-error`]),
    ].map((id) => [id, new Element()]),
  );
  const cards = Array.from({ length: 3 }, () => new Element());
  const steps = Array.from({ length: 3 }, () => new Element());
  const background = [new Element(), new Element()];
  const dialog = elements["setup-dialog"];
  dialog.querySelectorAll = (selector) => (selector === ".setup-card" ? cards : steps);
  dialog.showModal = () => {
    events.push("showModal");
    dialog.open = true;
  };
  dialog.close = () => {
    dialog.open = false;
    dialog.dispatchEvent(new Event("close"));
  };
  const document = new EventTarget();
  document.getElementById = (id) => {
    assert.ok(elements[id], id);
    return elements[id];
  };
  document.querySelector = (selector) => (selector === ".app-header" ? background[0] : background[1]);
  document.querySelectorAll = () => [];
  document.body = { classList: { remove: (name) => events.push(`remove:${name}`) } };
  const context = vm.createContext({
    document,
    window: new EventTarget(),
    HTMLElement: Element,
    Event,
    matchMedia: () => ({ matches: true }),
    localStorage: { setItem: (key, value) => events.push(`${key}:${value}`) },
    console: { warn: () => events.push("warn") },
  });
  vm.runInContext(setupBundle.outputFiles[0].text, context);
  const open = context.setupUI.createSetupDialog({
    getSettings: () => ({ token: "token", author: "Author", email: "name@example.com" }),
    validateToken: async (token) => {
      events.push(`validate:${token}`);
      return validateToken(token);
    },
    saveField: (key) => {
      events.push(`save:${key}`);
      return saveField(key);
    },
    persistTheme: () => {
      events.push("theme");
      persistTheme();
    },
    refreshDocuments: async () => {
      events.push("refresh");
    },
  });
  const closed = open();
  return { elements, dialog, background, events, closed, submit: () => elements["setup-form"].onsubmit({ preventDefault() {} }) };
}

test("setup module saves in step order, persists theme before completion, and cleans up on close", async () => {
  const f = setupFixture();
  assert.ok(f.background.every((element) => element.inert));
  assert.equal(f.dialog.dataset.step, "0");
  await f.submit();
  assert.equal(f.dialog.dataset.step, "1");
  await f.submit();
  assert.equal(f.dialog.dataset.step, "2");
  await f.submit();
  await f.closed;
  assert.deepEqual(
    f.events.filter((event) => /^(validate|save|refresh|theme|aux-setup-complete)/.test(event)),
    [
      "aux-setup-complete:false",
      "validate:token",
      "aux-setup-complete:false",
      "save:token",
      "refresh",
      "aux-setup-complete:false",
      "save:author",
      "save:email",
      "aux-setup-complete:false",
      "theme",
      "aux-setup-complete:true",
    ],
  );
  assert.ok(f.background.every((element) => !element.inert));
  assert.equal(f.elements["setup-form"].onsubmit, null);
  assert.equal(f.dialog.onkeydown, null);
  assert.equal(f.dialog.oncancel, null);
  assert.ok(f.events.includes("remove:setup-pending"));
});

test("setup rejects unauthorized tokens without saving or advancing and unlocks controls", async () => {
  const f = setupFixture({
    validateToken: async () => {
      throw { status: 401 };
    },
  });
  await f.submit();
  assert.equal(f.dialog.dataset.step, "0");
  assert.match(f.elements["setup-token-error"].textContent, /invalid or expired/);
  assert.equal(f.elements["setup-token"].hasAttribute("aria-invalid"), true);
  for (const id of ["setup-token", "setup-close", "setup-next"]) assert.equal(f.elements[id].disabled, false);
  assert.equal(
    f.events.some((event) => event.startsWith("save:")),
    false,
  );
  f.dialog.close();
  await f.closed;
});

test("setup does not advance when saving a field fails", async () => {
  const f = setupFixture({ saveField: () => false });
  await f.submit();
  assert.equal(f.dialog.dataset.step, "0");
  assert.equal(f.elements["setup-status"].textContent, "Could not save setup in this browser. Try again.");
  assert.equal(f.events.includes("refresh"), false);
  f.dialog.close();
  await f.closed;
});

test("setup prevents cancellation and duplicate submissions while token validation is pending", async () => {
  let resolve;
  const f = setupFixture({
    validateToken: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const pending = f.submit();
  assert.equal(f.elements["setup-next"].disabled, true);
  let prevented = false;
  f.dialog.oncancel({
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  await f.submit();
  assert.equal(f.events.filter((event) => event === "validate:token").length, 1);
  resolve({ id: 1 });
  await pending;
  assert.equal(f.dialog.dataset.step, "1");
  assert.equal(f.elements["setup-next"].disabled, false);
  f.dialog.close();
  await f.closed;
});

test("setup theme persistence errors keep the final step open and incomplete", async () => {
  const f = setupFixture({
    persistTheme: () => {
      throw new Error("blocked");
    },
  });
  await f.submit();
  await f.submit();
  await f.submit();
  assert.equal(f.dialog.dataset.step, "2");
  assert.equal(f.dialog.open, true);
  assert.equal(f.events.includes("aux-setup-complete:true"), false);
  assert.equal(f.elements["setup-status"].textContent, "Could not save setup in this browser. Try again.");
  f.dialog.close();
  await f.closed;
});
