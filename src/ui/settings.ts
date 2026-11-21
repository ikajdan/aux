// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { $ } from "./application-elements.js";
import { createSetupDialog } from "./setup.js";
import { restoreFocus } from "../modal-dialogs.js";
import { sanitizeCustomRepositoryUrls } from "../projects/custom-repositories.js";
import type { Settings, StatusState, Operation, OperationOptions } from "../application-types.js";

interface SettingsOptions {
  initialSettings: Settings;
  theme: { readonly selectedTheme: string; selectTheme: (value: string) => void };
  getCustomRepositories: () => string[];
  setCustomRepositories: (values: string[]) => void;
  saveCustomRepositories: () => Promise<unknown>;
  refreshDocuments: (options?: { background?: boolean }) => Promise<unknown>;
  renderCatalog: () => void;
  updatePageTitle: () => void;
  status: (text: string, state?: StatusState) => void;
  isBusy: () => boolean;
  run: (action: Operation, label: string, quiet?: boolean, background?: boolean, options?: OperationOptions) => Promise<unknown>;
  validateToken: (candidate: string) => Promise<{ id: number }>;
}

export function createSettingsController({
  initialSettings,
  theme,
  getCustomRepositories,
  setCustomRepositories,
  saveCustomRepositories,
  refreshDocuments,
  renderCatalog,
  updatePageTitle,
  status,
  isBusy,
  run,
  validateToken,
}: SettingsOptions) {
  let settings = initialSettings;
  function setupComplete() {
    const email = document.createElement("input");
    email.type = "email";
    email.value = typeof settings.email === "string" ? settings.email.trim() : "";
    return ["token", "author", "email"].every((key) => typeof settings[key] === "string" && settings[key].trim()) && email.validity.valid;
  }
  let settingsSnapshot: { settings: Settings; repositories: string[]; theme: string } | undefined;
  let settingsActionRunning = false;
  function hasSettingsChanges() {
    if (!settingsSnapshot) return false;
    const snapshot = settingsSnapshot;
    return (
      settingsKeys.some((key) => $(key).value !== (snapshot.settings[key] || "") || (settings[key] || "") !== (snapshot.settings[key] || "")) ||
      $<HTMLTextAreaElement>("custom-repositories").value !== snapshot.repositories.join("\n") ||
      JSON.stringify(getCustomRepositories()) !== JSON.stringify(snapshot.repositories) ||
      theme.selectedTheme !== snapshot.theme
    );
  }
  function updateRestoreState() {
    $("restore-settings").disabled = settingsActionRunning || !hasSettingsChanges();
  }
  function openConnection() {
    $("connection-status").textContent = "";
    $("custom-repositories-status").textContent = "";
    $("settings-title-text").textContent = "Settings";
    if (!$("connection-dialog").open) {
      settingsSnapshot = { settings: { ...settings }, repositories: [...getCustomRepositories()], theme: theme.selectedTheme };
      $("connection-dialog").showModal();
    }
    updateRestoreState();
    updatePageTitle();
  }
  const settingsKeys = ["token", "author", "email"] as const;
  let persistenceRequested = false;
  const failedSettings = new Set();
  function settingsStatus(text: string, state: StatusState = "ready") {
    $("connection-status").textContent = text;
    $("connection-status").dataset.state = state;
  }
  function saveSettingsField(key: (typeof settingsKeys)[number], validate = false) {
    try {
      const input = $<HTMLInputElement>(key);
      const value = input.value.trim();
      const error = $(`${key}-error`);
      const changed = value !== (settings[key] || "");
      if (!changed && !validate && !input.hasAttribute("aria-invalid")) return;
      const message = !value
        ? { token: "Enter a personal access token.", author: "Enter an author name.", email: "Enter an email address." }[key]
        : key === "email" && !input.validity.valid
          ? "Enter a valid email address, such as name@example.com."
          : "";
      error.textContent = message;
      error.hidden = !message;
      if (message) {
        input.setAttribute("aria-invalid", "true");
        if (!failedSettings.size) settingsStatus("");
        return;
      }
      input.removeAttribute("aria-invalid");
      input.value = value;
      if (!changed) return;
      const next = { ...settings, [key]: value };
      try {
        localStorage.setItem("aux-settings", JSON.stringify(next));
      } catch (error) {
        console.warn("Could not save settings", error);
        failedSettings.add(key);
        settingsStatus("Could not save settings. Try again.", "error");
        return;
      }
      settings = next;
      failedSettings.delete(key);
      settingsStatus(failedSettings.size ? "Could not save settings. Try again." : "", failedSettings.size ? "error" : "ready");
      if (key === "token" && !$<HTMLDialogElement>("setup-dialog").open) {
        void refreshDocuments({ background: true }).catch((error) => {
          if (settings.token === value && input.value.trim() === value) {
            settingsStatus(`Settings saved. Could not refresh documents: ${error.message}`, "error");
          }
        });
      }
      if (!persistenceRequested) {
        persistenceRequested = true;
        Promise.resolve()
          .then(() => navigator.storage?.persist?.())
          .catch((error) => {
            console.warn("Could not request persistent storage", error);
          });
      }
    } finally {
      updateRestoreState();
    }
  }
  function saveSettingsFields(validate = false) {
    for (const key of settingsKeys) saveSettingsField(key, validate);
  }
  async function saveAllSettings() {
    try {
      $("custom-repositories-status").textContent = "";
      saveSettingsFields(true);
      const invalid = settingsKeys.map((key) => $<HTMLInputElement>(key)).find((input) => input.hasAttribute("aria-invalid"));
      if (invalid || failedSettings.size) {
        if (invalid) {
          settingsStatus("Check the highlighted fields.", "error");
          restoreFocus(invalid);
        }
        return false;
      }
      settingsStatus("");
      await saveCustomRepositories();
      if (!$("custom-repositories-status").textContent) settingsStatus("Settings saved.");
    } finally {
      updateRestoreState();
    }
  }
  async function restoreSettings() {
    try {
      if (!settingsSnapshot) return false;
      const snapshot = settingsSnapshot;
      const next = {
        ...settings,
        token: snapshot.settings.token,
        author: snapshot.settings.author,
        email: snapshot.settings.email,
        customRepositories: [...snapshot.repositories],
      };
      const refresh = (settings.token || "") !== (next.token || "") || JSON.stringify(getCustomRepositories()) !== JSON.stringify(snapshot.repositories);
      try {
        const previous = localStorage.getItem("aux-settings");
        localStorage.setItem("aux-settings", JSON.stringify(next));
        try {
          theme.selectTheme(snapshot.theme);
        } catch (error) {
          if (previous === null) localStorage.removeItem("aux-settings");
          else localStorage.setItem("aux-settings", previous);
          throw error;
        }
      } catch (error) {
        console.warn("Could not restore settings", error);
        settingsStatus("Could not restore settings in this browser. Try again.", "error");
        return false;
      }
      settings = next;
      setCustomRepositories([...snapshot.repositories]);
      failedSettings.clear();
      for (const key of settingsKeys) {
        $(key).value = settings[key] || "";
        $(key).removeAttribute("aria-invalid");
        $(`${key}-error`).textContent = "";
        $(`${key}-error`).hidden = true;
      }
      $<HTMLTextAreaElement>("custom-repositories").value = getCustomRepositories().join("\n");
      $("custom-repositories").removeAttribute("aria-invalid");
      $("custom-repositories-status").textContent = "";
      settingsStatus("Settings restored.");
      if (refresh) {
        renderCatalog();
        try {
          await refreshDocuments();
          settingsStatus("Settings restored. Documents refreshed.");
        } catch (error) {
          settingsStatus(`Settings restored. Could not refresh documents: ${error.message}`, "error");
          return false;
        }
      }
    } finally {
      updateRestoreState();
    }
  }
  function runSettingsAction(action: Operation, label: string) {
    const buttons = [$("save-settings"), $("restore-settings")];
    if (isBusy() || settingsActionRunning || (action === restoreSettings && !hasSettingsChanges())) return;
    settingsActionRunning = true;
    buttons.forEach((button) => {
      button.disabled = true;
    });
    void run(action, label, false, false, { initialProgress: false, completion: false, allowSaveFailure: true }).finally(() => {
      settingsActionRunning = false;
      $("save-settings").disabled = false;
      updateRestoreState();
    });
  }
  const openSetup = createSetupDialog({
    getSettings: () => settings,
    validateToken: (candidate) => validateToken(candidate),
    saveField: (key) => {
      saveSettingsField(key, true);
      return !failedSettings.has(key);
    },
    persistTheme: () => theme.selectTheme(theme.selectedTheme),
    refreshDocuments: () => refreshDocuments({ background: true }),
  });
  function installUI() {
    updateRestoreState();
    for (const type of ["input", "change", "click", "keydown"] as const) {
      $("connection-dialog").addEventListener(type, updateRestoreState);
    }
    for (const key of ["token", "author", "email"] as const) $<HTMLInputElement>(key).value = settings[key] || "";
    $<HTMLTextAreaElement>("custom-repositories").value = getCustomRepositories().join("\n");
    $<HTMLTextAreaElement>("custom-repositories").addEventListener("paste", (event) => {
      const pasted = event.clipboardData?.getData("text/plain");
      if (!pasted) return;
      const sanitized = sanitizeCustomRepositoryUrls(pasted);
      if (sanitized === pasted) return;
      event.preventDefault();
      const input = event.currentTarget as HTMLTextAreaElement;
      input.setRangeText(sanitized, input.selectionStart, input.selectionEnd, "end");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (const key of settingsKeys) {
      $<HTMLInputElement>(key).addEventListener("blur", () => saveSettingsField(key, true));
      $<HTMLInputElement>(key).addEventListener("input", () => {
        if (!failedSettings.size) settingsStatus("");
      });
      $<HTMLInputElement>(key).addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.isComposing) return;
        event.preventDefault();
        $("connection-form").dispatchEvent(new Event("submit", { cancelable: true }));
      });
    }
    $("connection-form").onsubmit = (event) => {
      event.preventDefault();
      runSettingsAction(saveAllSettings, "Save settings");
    };
    $("restore-settings").onclick = () => runSettingsAction(restoreSettings, "Restore settings");

    $("app-menu").onclick = openConnection;
    $("connection-dialog").onclose = () => {
      saveSettingsFields();
      void saveCustomRepositories().catch((error) => status(error.message, "error"));
      settingsSnapshot = undefined;
      updateRestoreState();
      updatePageTitle();
      $("app-menu").focus();
    };
  }
  return {
    get values() {
      return settings;
    },
    setValues(value: Settings) {
      settings = value;
      updateRestoreState();
    },
    openConnection,
    settingsStatus,
    saveSettingsField,
    saveAllSettings,
    restoreSettings,
    setupComplete,
    openSetup,
    installUI,
  };
}
