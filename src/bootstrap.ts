// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { loadServerConfig } from "./server-config.js";

function checkBrowserStorage() {
  const key = `aux-storage-check-${Math.random().toString(36).slice(2)}`;
  try {
    const storage = globalThis.localStorage;
    storage.setItem(key, key);
    const readable = storage.getItem(key) === key;
    storage.removeItem(key);
    if (!readable) throw new Error("Browser storage did not retain the written value");
    return true;
  } catch (error) {
    console.warn("Browser storage is unavailable", error);
    const container = document.createElement("main");
    container.className = "startup-message";
    container.setAttribute("role", "alert");
    const title = document.createElement("h1");
    title.textContent = "Browser storage is unavailable";
    const message = document.createElement("p");
    message.textContent =
      "Aux requires browser storage to save settings and local repository changes. Allow site storage, then reload. If storage is full, free up space without deleting unpublished Aux work.";
    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "primary";
    reload.textContent = "Reload";
    reload.onclick = () => location.reload();
    container.append(title, message, reload);
    document.body.classList.remove("setup-pending");
    document.body.replaceChildren(container);
    return false;
  }
}

async function start() {
  if (!checkBrowserStorage()) return;
  await loadServerConfig();
  await import("./application.js");
}
void start().catch((error) => {
  console.error("Application startup failed", error);
  const message = document.createElement("p");
  message.setAttribute("role", "alert");
  message.textContent = "Could not start Aux. Check the server configuration and refresh the page.";
  document.body.replaceChildren(message);
});
