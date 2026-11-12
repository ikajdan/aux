// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { loadServerConfig } from "./server-config.js";

async function start() {
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
