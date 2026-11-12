// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { icon, type IconName } from "../ui-icons.js";

export interface DialogShellOptions {
  title: string;
  titleId: string;
  icon?: IconName;
  closeId?: string;
  titleTextId?: string;
  closeAutofocus?: boolean;
}

export function configureDialog(dialog: HTMLDialogElement, options: DialogShellOptions) {
  const body = dialog.querySelector<HTMLElement>(":scope > .dialog-body");
  if (!body) throw new Error("Dialogs require a direct .dialog-body child");
  if (dialog.querySelector(":scope > .dialog-heading")) throw new Error("Dialog shell already configured");
  dialog.classList.add("dialog-shell");
  dialog.setAttribute("aria-labelledby", options.titleId);
  const header = document.createElement("header");
  header.className = "dialog-heading";
  const title = document.createElement("h2");
  title.id = options.titleId;
  title.className = "dialog-title";
  if (options.icon) title.append(icon(options.icon));
  const titleText = document.createElement("span");
  titleText.textContent = options.title;
  if (options.titleTextId) titleText.id = options.titleTextId;
  title.append(titleText);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "dialog-close";
  if (options.closeId) close.id = options.closeId;
  close.setAttribute("aria-label", "Close dialog");
  close.title = "Close";
  close.autofocus = options.closeAutofocus ?? false;
  close.append(icon("close"));
  close.onclick = () => {
    if (!dialog.open || close.disabled) return;
    if (typeof dialog.requestClose === "function") dialog.requestClose();
    else if (dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) dialog.close();
  };
  header.append(title, close);
  dialog.prepend(header);
  return { dialog, header, body, title: titleText, close };
}

export function initializeDialogShells() {
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[data-dialog-title]")) {
    configureDialog(dialog, {
      title: dialog.dataset.dialogTitle,
      titleId: dialog.getAttribute("aria-labelledby"),
      icon: dialog.dataset.dialogIcon as IconName | undefined,
      closeId: dialog.dataset.dialogClose,
      titleTextId: dialog.dataset.dialogTitleText,
      closeAutofocus: dialog.hasAttribute("data-dialog-close-autofocus"),
    });
  }
}
