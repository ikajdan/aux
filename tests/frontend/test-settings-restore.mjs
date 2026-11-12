// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { build, transform } from "esbuild";

const source = await readFile("src/application.ts", "utf8");
async function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Missing extraction markers: ${startMarker} / ${endMarker}`);
  return (await transform(source.slice(start, end), { loader: "ts" })).code;
}
const restoreCode = await extract("async function restoreSettings()", "function runSettingsAction(");
const openCode = await extract("let settingsSnapshot", "for (const id of");
const bundledTheme = await build({ entryPoints: ["src/ui/theme.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { createThemeController } = await import(`data:text/javascript;base64,${Buffer.from(bundledTheme.outputFiles[0].text).toString("base64")}`);
const keys = ["token", "author", "email"];
const original = {
  token: "opening-token",
  author: "Opening Author",
  email: "opening@example.com",
  customRepositories: ["group/opening"],
  paneRatio: 0.4,
};
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture({ capture = true, storedSettings = JSON.stringify(original) } = {}) {
  const elements = Object.fromEntries(
    [
      ...keys,
      ...keys.map((key) => `${key}-error`),
      "connection-status",
      "custom-repositories",
      "custom-repositories-status",
      "settings-title-text",
      "connection-dialog",
    ].map((id) => [id, {
      value: keys.includes(id) ? original[id] : id === "custom-repositories" ? "group/opening" : "",
      textContent: "",
      hidden: true,
      attributes: new Map(),
      removeAttribute(name) { this.attributes.delete(name); },
      hasAttribute(name) { return this.attributes.has(name); },
      setAttribute(name, value) { this.attributes.set(name, value); },
    }]),
  );
  let modalOpens = 0;
  elements["connection-dialog"].open = false;
  elements["connection-dialog"].showModal = function () {
    this.open = true;
    modalOpens++;
  };
  const storage = new Map([["aux-theme", "light"]]);
  if (storedSettings !== null) storage.set("aux-settings", storedSettings);
  const accesses = [];
  const statuses = [];
  const warnings = [];
  const appliedThemes = [];
  const catalogStates = [];
  let refreshes = 0;
  let storageFailure;
  let refreshFailure;
  const context = vm.createContext({
    $: (id) => {
      assert.ok(elements[id], `Unexpected element: ${id}`);
      return elements[id];
    },
    settings: structuredClone(original),
    customRepositories: [...original.customRepositories],
    settingsKeys: keys,
    failedSettings: new Set(),
    localStorage: {
      getItem(key) {
        accesses.push(["get", key]);
        if (storageFailure?.("get", key)) throw new Error("Storage unavailable");
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        accesses.push(["set", key, value]);
        if (storageFailure?.("set", key)) throw new Error("Storage unavailable");
        storage.set(key, value);
      },
      removeItem(key) {
        accesses.push(["remove", key]);
        if (storageFailure?.("remove", key)) throw new Error("Storage unavailable");
        storage.delete(key);
      },
    },
    settingsStatus: (text, state = "ready") => {
      statuses.push([text, state]);
      elements["connection-status"].textContent = text;
    },
    renderCatalog: () => catalogStates.push({
      token: context.settings.token,
      repositories: plain(context.customRepositories),
    }),
    refreshDocuments: async () => {
      refreshes++;
      if (refreshFailure) throw refreshFailure;
    },
    updatePageTitle() {},
    console: { warn: (...args) => warnings.push(args) },
  });
  context.theme = createThemeController({
    root: { dataset: {} }, groups: [], savedThemeValue: "light",
    media: () => ({ matches: false, addEventListener() {} }),
    storage: context.localStorage, setupStatus: {}, reportSettingsError() {},
  });
  context.theme.connectEditor((value) => appliedThemes.push(value));
  appliedThemes.length = 0;
  vm.runInContext(openCode + restoreCode, context);
  if (capture) context.openConnection();
  return {
    context, elements, storage, accesses, statuses, warnings, appliedThemes, catalogStates,
    restore: () => context.restoreSettings(),
    open: () => context.openConnection(),
    snapshot: () => vm.runInContext("settingsSnapshot", context),
    failStorage: (failure) => { storageFailure = failure; },
    failRefresh: () => { refreshFailure = new Error("Catalog offline"); },
    get refreshes() { return refreshes; },
    get modalOpens() { return modalOpens; },
  };
}

function autosave(f, changes) {
  Object.assign(f.context.settings, changes);
  for (const key of keys) f.elements[key].value = f.context.settings[key] || "";
  if (changes.customRepositories) {
    f.context.customRepositories = [...changes.customRepositories];
    f.elements["custom-repositories"].value = changes.customRepositories.join("\n");
  }
  f.storage.set("aux-settings", JSON.stringify(f.context.settings));
}

function assertNoRefresh(f) {
  assert.equal(f.refreshes, 0);
  assert.deepEqual(f.catalogStates, []);
}

test("opening Settings captures a detached snapshot only for a new dialog session", () => {
  const f = fixture({ capture: false });
  assert.equal(f.snapshot(), undefined);
  f.open();
  const snapshot = f.snapshot();
  assert.deepEqual(plain(snapshot), { settings: original, repositories: original.customRepositories, theme: "light" });
  assert.notEqual(snapshot.settings, f.context.settings);
  assert.notEqual(snapshot.repositories, f.context.customRepositories);
  f.context.settings.token = "autosaved-token";
  f.context.customRepositories.push("group/added");
  f.context.theme.selectTheme("dark");
  f.open();
  assert.equal(f.snapshot(), snapshot);
  assert.equal(snapshot.settings.token, original.token);
  assert.deepEqual(plain(snapshot.repositories), original.customRepositories);
  assert.equal(snapshot.theme, "light");
  assert.equal(f.modalOpens, 1);
  f.elements["connection-dialog"].open = false;
  f.open();
  assert.notEqual(f.snapshot(), snapshot);
  assert.equal(f.snapshot().settings.token, "autosaved-token");
  assert.deepEqual(plain(f.snapshot().repositories), ["group/opening", "group/added"]);
  assert.equal(f.snapshot().theme, "dark");
  assert.equal(f.modalOpens, 2);
});

test("Restore undoes already-autosaved credentials, repositories and theme but preserves current paneRatio", async () => {
  const f = fixture();
  autosave(f, { token: "saved-token", author: "Saved Author", email: "saved@example.com", customRepositories: ["group/saved"], paneRatio: 0.75 });
  f.context.theme.selectTheme("dark");
  await f.restore();
  const expected = { ...original, paneRatio: 0.75 };
  assert.deepEqual(plain(f.context.settings), expected);
  assert.deepEqual(JSON.parse(f.storage.get("aux-settings")), expected);
  assert.deepEqual(plain(f.context.customRepositories), original.customRepositories);
  assert.equal(f.context.theme.selectedTheme, "light");
  assert.equal(f.storage.get("aux-theme"), "light");
  for (const key of keys) assert.equal(f.elements[key].value, original[key]);
  assert.equal(f.elements["custom-repositories"].value, "group/opening");
  assert.equal(f.refreshes, 1);
  assert.deepEqual(f.catalogStates, [{ token: original.token, repositories: original.customRepositories }]);
  assert.deepEqual(f.statuses.at(-1), ["Settings restored. Documents refreshed.", "ready"]);
});

test("Restore clears all field errors, repository feedback and failedSettings", async () => {
  const f = fixture();
  for (const key of keys) {
    f.context.failedSettings.add(key);
    f.elements[key].value = "invalid draft";
    f.elements[key].setAttribute("aria-invalid", "true");
    f.elements[`${key}-error`].textContent = "Invalid field";
    f.elements[`${key}-error`].hidden = false;
  }
  f.elements["custom-repositories"].setAttribute("aria-invalid", "true");
  f.elements["custom-repositories-status"].textContent = "Invalid repository";
  await f.restore();
  assert.equal(f.context.failedSettings.size, 0);
  for (const key of keys) {
    assert.equal(f.elements[key].value, original[key]);
    assert.equal(f.elements[key].hasAttribute("aria-invalid"), false);
    assert.equal(f.elements[`${key}-error`].textContent, "");
    assert.equal(f.elements[`${key}-error`].hidden, true);
  }
  assert.equal(f.elements["custom-repositories"].hasAttribute("aria-invalid"), false);
  assert.equal(f.elements["custom-repositories-status"].textContent, "");
});

for (const changes of [{ token: "saved-token" }, { customRepositories: ["group/other"] }, { customRepositories: [] }]) {
  test(`Restore refreshes the catalog for an autosaved ${Object.keys(changes)[0]} change (${JSON.stringify(changes)})`, async () => {
    const f = fixture();
    autosave(f, changes);
    await f.restore();
    assert.equal(f.refreshes, 1);
    assert.equal(f.catalogStates.length, 1);
  });
}

test("Restore does not refresh for theme-only changes", async () => {
  const f = fixture();
  f.context.theme.selectTheme("dark");
  await f.restore();
  assert.equal(f.context.theme.selectedTheme, "light");
  assertNoRefresh(f);
});

test("Restore does not refresh for identity-only changes or an unchanged repository list", async () => {
  const f = fixture();
  autosave(f, { author: "Saved Author", email: "saved@example.com", customRepositories: [...original.customRepositories] });
  await f.restore();
  assertNoRefresh(f);
});

test("Restore does not refresh for an unsaved token input when the active token has not changed", async () => {
  const f = fixture();
  f.elements.token.value = "unsaved-token";
  await f.restore();
  assert.equal(f.elements.token.value, original.token);
  assertNoRefresh(f);
});

test("Restore refreshes an autosaved token even when its input was reverted without saving", async () => {
  const f = fixture();
  autosave(f, { token: "saved-token" });
  f.elements.token.value = original.token;
  await f.restore();
  assert.equal(f.context.settings.token, original.token);
  assert.equal(f.refreshes, 1);
  assert.equal(f.catalogStates.length, 1);
});

for (const operation of ["get", "set"]) {
  test(`Restore reports aux-settings ${operation} failure without mutating in-memory state`, async () => {
    const f = fixture();
    autosave(f, { token: "saved-token", customRepositories: ["group/saved"] });
    f.context.theme.selectTheme("dark");
    f.context.failedSettings.add("token");
    f.elements.token.setAttribute("aria-invalid", "true");
    const settings = f.context.settings;
    const repositories = f.context.customRepositories;
    const before = plain(settings);
    const stored = f.storage.get("aux-settings");
    f.failStorage((method, key) => method === operation && key === "aux-settings");
    assert.equal(await f.restore(), false);
    assert.equal(f.context.settings, settings);
    assert.deepEqual(plain(settings), before);
    assert.equal(f.context.customRepositories, repositories);
    assert.equal(f.context.theme.selectedTheme, "dark");
    assert.equal(f.elements.token.value, "saved-token");
    assert.equal(f.elements.token.hasAttribute("aria-invalid"), true);
    assert.equal(f.context.failedSettings.has("token"), true);
    assert.equal(f.storage.get("aux-settings"), stored);
    assert.deepEqual(f.statuses, [["Could not restore settings in this browser. Try again.", "error"]]);
    assert.equal(f.warnings.length, 1);
    assertNoRefresh(f);
  });
}

for (const previous of ["{\"token\":\"previous raw value\"}", null]) {
  test(`theme persistence failure restores the previous aux-settings key (${previous === null ? "absent" : "present"})`, async () => {
    const f = fixture();
    autosave(f, { token: "saved-token", customRepositories: ["group/saved"] });
    f.context.theme.selectTheme("dark");
    if (previous === null) f.storage.delete("aux-settings");
    else f.storage.set("aux-settings", previous);
    const settings = f.context.settings;
    const repositories = f.context.customRepositories;
    const before = plain(settings);
    f.failStorage((method, key) => method === "set" && key === "aux-theme");
    assert.equal(await f.restore(), false);
    assert.equal(f.storage.get("aux-settings") ?? null, previous);
    assert.equal(f.context.settings, settings);
    assert.deepEqual(plain(settings), before);
    assert.equal(f.context.customRepositories, repositories);
    assert.equal(f.context.theme.selectedTheme, "dark");
    assert.equal(f.storage.get("aux-theme"), "dark");
    assert.deepEqual(f.appliedThemes, ["dark"]);
    assert.deepEqual(f.statuses.at(-1), ["Could not restore settings in this browser. Try again.", "error"]);
    assertNoRefresh(f);
  });
}

test("catalog refresh failure reports restored-but-refresh-failed and keeps the restored state persisted", async () => {
  const f = fixture();
  autosave(f, { token: "saved-token", customRepositories: ["group/saved"], paneRatio: 0.8 });
  f.context.theme.selectTheme("dark");
  f.failRefresh();
  assert.equal(await f.restore(), false);
  const expected = { ...original, paneRatio: 0.8 };
  assert.deepEqual(plain(f.context.settings), expected);
  assert.deepEqual(JSON.parse(f.storage.get("aux-settings")), expected);
  assert.deepEqual(plain(f.context.customRepositories), original.customRepositories);
  assert.equal(f.context.theme.selectedTheme, "light");
  assert.equal(f.storage.get("aux-theme"), "light");
  assert.equal(f.refreshes, 1);
  assert.deepEqual(f.statuses.at(-1), ["Settings restored. Could not refresh documents: Catalog offline", "error"]);
  assert.ok(f.statuses.every(([text]) => !text.includes("Could not restore")));
});

test("Restore without a dialog-open snapshot is a no-op", async () => {
  const f = fixture({ capture: false });
  const settings = f.context.settings;
  const repositories = f.context.customRepositories;
  assert.equal(await f.restore(), false);
  assert.equal(f.context.settings, settings);
  assert.equal(f.context.customRepositories, repositories);
  assert.equal(f.context.theme.selectedTheme, "light");
  assert.deepEqual(f.accesses, []);
  assert.deepEqual(f.statuses, []);
  assert.deepEqual(f.appliedThemes, []);
  assertNoRefresh(f);
});

test("theme initializes the dataset before connecting the editor and follows system changes", () => {
  const root = { dataset: {} };
  const applied = [];
  let onChange;
  const system = { matches: true, addEventListener(type, listener) { assert.equal(type, "change"); onChange = listener; } };
  const theme = createThemeController({
    root, groups: [], savedThemeValue: "invalid", media: () => system,
    storage: { setItem() {} }, setupStatus: {}, reportSettingsError() {},
  });
  assert.equal(root.dataset.theme, "system");
  assert.deepEqual(applied, []);
  assert.equal(onChange, undefined);
  theme.connectEditor((value) => applied.push(value));
  system.matches = false;
  onChange();
  theme.selectTheme("dark");
  onChange();
  assert.deepEqual(applied, ["dark", "light", "dark", "dark"]);
  assert.equal(theme.selectedTheme, "dark");
});

test("theme keyboard controls synchronize groups and persistence failures retain the selection", () => {
  let fail = false;
  const errors = [];
  const setupStatus = { textContent: "old" };
  const groups = [false, true].map((setup) => {
    const buttons = ["light", "dark", "system"].map((value) => ({
      dataset: { themeChoice: value }, attributes: {}, focused: false,
      setAttribute(key, value) { this.attributes[key] = value; },
      focus() { this.focused = true; },
    }));
    return { dataset: {}, buttons, querySelectorAll: () => buttons, closest: () => setup };
  });
  const theme = createThemeController({
    root: { dataset: {} }, groups, savedThemeValue: "light",
    media: () => ({ matches: false, addEventListener() {} }),
    storage: { setItem() { if (fail) throw new Error("blocked"); } },
    setupStatus, reportSettingsError: (message) => errors.push(message),
  });
  theme.connectEditor(() => {});
  let prevented = false;
  groups[0].buttons[0].onkeydown({ key: "ArrowLeft", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(theme.selectedTheme, "system");
  assert.equal(groups[0].buttons[2].focused, true);
  for (const group of groups) {
    assert.equal(group.dataset.activeIndex, "2");
    assert.deepEqual(group.buttons.map((button) => button.tabIndex), [-1, -1, 0]);
    assert.deepEqual(group.buttons.map((button) => button.attributes["aria-checked"]), ["false", "false", "true"]);
  }
  fail = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    groups[0].buttons[0].onclick();
    groups[1].buttons[0].onclick();
  } finally { console.warn = warn; }
  assert.equal(theme.selectedTheme, "system");
  assert.deepEqual(errors, ["Could not save appearance. Try again."]);
  assert.equal(setupStatus.textContent, "Could not save appearance. Try again.");
});
