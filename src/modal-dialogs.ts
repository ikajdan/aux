// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { configureDialog } from "./ui/dialog-shell.js";
import { icon, type IconName } from "./ui-icons.js";

export interface DialogOptions {
  title?: string;
  icon?: IconName;
  label?: string;
  defaultValue?: string;
  cancelLabel?: string;
  confirmLabel?: string;
  confirmIcon?: IconName;
  actionIcons?: boolean;
  destructive?: boolean;
  emphasizeFirstParagraph?: boolean;
  emphasizeText?: string;
  suggestions?: readonly string[];
  links?: readonly { label: string; href: string }[];
}
export interface UploadConflictResult {
  action: "replace" | "skip" | "keep-both";
  applyToRemaining: boolean;
}

type DialogKind = "confirm" | "prompt" | "alert" | "saveChanges" | "uploadConflict";
const defaultDialogIcons: Record<DialogKind, IconName> = {
  confirm: "warning",
  prompt: "editDocument",
  alert: "note",
  saveChanges: "save",
  uploadConflict: "warning",
};
type SaveChangesOptions = DialogOptions & { discardLabel?: string };
type DialogResult = string | boolean | null | void | UploadConflictResult;

let queue: Promise<unknown> = Promise.resolve();
const pending = new Map<string, Promise<DialogResult>>();
let sequence = 0;

export function installBackdropCancellation(dialog: HTMLDialogElement) {
  let pointerId: number | null = null;
  const outside = (event: PointerEvent) => {
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  };
  const reset = () => {
    pointerId = null;
  };
  const down = (event: PointerEvent) => {
    pointerId = dialog.open && event.target === dialog && event.isPrimary && event.button === 0 && outside(event) ? event.pointerId : null;
  };
  const up = (event: PointerEvent) => {
    const dismiss = pointerId === event.pointerId && event.isPrimary && event.button === 0 && dialog.open && event.target === dialog && outside(event);
    reset();
    if (!dismiss) return;
    if (typeof dialog.requestClose === "function") dialog.requestClose();
    else if (dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) dialog.close();
  };
  // Native backdrop events target the modal itself, not an underlying dialog.
  document.addEventListener("pointerdown", down, true);
  document.addEventListener("pointerup", up, true);
  document.addEventListener("pointercancel", reset, true);
  window.addEventListener("blur", reset);
  dialog.addEventListener("close", reset);
  return () => {
    document.removeEventListener("pointerdown", down, true);
    document.removeEventListener("pointerup", up, true);
    document.removeEventListener("pointercancel", reset, true);
    window.removeEventListener("blur", reset);
    dialog.removeEventListener("close", reset);
    reset();
  };
}

export function installInputConfirmation(input: HTMLInputElement, button: HTMLButtonElement) {
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
    if (input.tagName !== "INPUT") return;
    event.preventDefault();
    if (event.repeat || input.disabled || button.disabled || button.dataset.loading === "true" || button.getAttribute("aria-busy") === "true") return;
    button.click();
  });
}

export function restoreFocus(element: Element | null) {
  if (
    !(element instanceof HTMLElement) ||
    !element.isConnected ||
    element.matches(":disabled") ||
    element.closest("[hidden], [inert]") ||
    !element.getClientRects().length
  )
    return;
  const modals = [...document.querySelectorAll("dialog[open]")];
  if (modals.length && !modals.at(-1).contains(element)) return;
  element.focus({ preventScroll: true });
}

function showDialog(kind: DialogKind, message: string, options: SaveChangesOptions = {}): Promise<DialogResult> {
  const key = JSON.stringify([kind, message, options]);
  if (pending.has(key)) return pending.get(key);
  const task = queue.then(
    () =>
      new Promise<DialogResult>((resolve, reject) => {
        const previousFocus = document.activeElement;
        const dialog = document.createElement("dialog");
        dialog.className = "app-dialog";
        const id = `app-dialog-${++sequence}`;
        dialog.setAttribute("aria-labelledby", `${id}-title`);
        dialog.setAttribute("aria-describedby", `${id}-description`);
        const form = document.createElement("form");
        form.method = "dialog";
        form.className = "dialog-body";
        const title =
          options.title ||
          { confirm: "Confirm action", prompt: "Enter a value", alert: "Notice", saveChanges: "Save changes", uploadConflict: "File already exists" }[kind];
        const description = document.createElement("p");
        description.id = `${id}-description`;
        if (options.emphasizeText && message.includes(options.emphasizeText)) {
          const start = message.indexOf(options.emphasizeText);
          const before = document.createElement("span");
          before.textContent = message.slice(0, start);
          const emphasis = document.createElement("strong");
          emphasis.textContent = options.emphasizeText;
          const after = document.createElement("span");
          after.textContent = message.slice(start + options.emphasizeText.length);
          description.append(before, emphasis, after);
        } else if (options.emphasizeFirstParagraph) {
          const separator = message.indexOf("\n\n");
          const lead = document.createElement("strong");
          lead.textContent = separator < 0 ? message : message.slice(0, separator);
          description.append(lead);
          if (separator >= 0) {
            const details = document.createElement("span");
            details.textContent = message.slice(separator);
            description.append(details);
          }
        } else description.textContent = message;
        form.append(description);
        if (options.links?.length) {
          const links = document.createElement("div");
          links.className = "dialog-links";
          for (const { label, href } of options.links) {
            let url: URL;
            try {
              url = new URL(href);
            } catch {
              continue;
            }
            if (url.protocol !== "https:") continue;
            const link = document.createElement("a");
            link.textContent = label;
            link.href = url.href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.append(icon("external"));
            links.append(link);
          }
          if (links.children.length) form.append(links);
        }
        let input: HTMLInputElement;
        if (kind === "prompt") {
          const label = document.createElement("label");
          label.htmlFor = `${id}-input`;
          label.textContent = options.label || "Value";
          input = document.createElement("input");
          input.id = label.htmlFor;
          input.type = "text";
          input.value = options.defaultValue || "";
          input.autocomplete = "off";
          input.setAttribute("aria-describedby", description.id);
          form.append(label, input);
          if (options.suggestions?.length) {
            const suggestions = document.createElement("div");
            suggestions.className = "dialog-suggestions";
            suggestions.setAttribute("role", "group");
            suggestions.setAttribute("aria-label", "Suggestions");
            for (const value of options.suggestions) {
              const button = document.createElement("button");
              button.type = "button";
              button.textContent = value;
              button.setAttribute("aria-label", `Use ${value}`);
              button.onclick = () => {
                input.value = value;
                form.requestSubmit();
              };
              suggestions.append(button);
            }
            form.append(suggestions);
          }
        }
        let applyToRemaining: HTMLInputElement;
        if (kind === "uploadConflict") {
          const label = document.createElement("label");
          label.className = "upload-conflict-apply";
          applyToRemaining = document.createElement("input");
          applyToRemaining.type = "checkbox";
          applyToRemaining.checked = false;
          applyToRemaining.id = `${id}-apply-to-remaining`;
          label.htmlFor = applyToRemaining.id;
          const text = document.createElement("span");
          text.textContent = "Apply to remaining conflicts";
          label.append(applyToRemaining, text);
          form.append(label);
        }
        const actions = document.createElement("div");
        actions.className = "dialog-actions";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = options.cancelLabel || "Cancel";
        if (options.actionIcons !== false) cancel.prepend(icon("close"));
        cancel.onclick = () => dialog.close();
        const confirm = document.createElement("button");
        confirm.type = "submit";
        confirm.textContent = options.confirmLabel || (kind === "alert" ? "OK" : "Confirm");
        confirm.className = options.destructive ? "destructive" : "primary";
        if (options.actionIcons !== false)
          confirm.prepend(icon(options.confirmIcon ?? (kind === "saveChanges" ? "save" : options.destructive ? (options.icon ?? "warning") : "check")));
        if (kind !== "alert") actions.append(cancel);
        if (kind === "saveChanges") {
          const discard = document.createElement("button");
          discard.type = "button";
          discard.textContent = options.discardLabel ?? "Discard";
          if (options.actionIcons !== false) discard.prepend(icon("restore"));
          discard.onclick = () => {
            result = "discard";
            dialog.close();
          };
          actions.append(discard);
        }
        if (kind === "uploadConflict") {
          for (const action of ["replace", "skip"] as const) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = action === "replace" ? "Replace" : "Skip";
            if (action === "replace") button.className = "destructive";
            button.onclick = () => {
              result = { action, applyToRemaining: applyToRemaining.checked };
              dialog.close();
            };
            actions.append(button);
          }
        }
        actions.append(confirm);
        form.append(actions);
        dialog.append(form);
        configureDialog(dialog, { title, titleId: `${id}-title`, icon: options.icon ?? defaultDialogIcons[kind] });
        const removeBackdropCancellation = installBackdropCancellation(dialog);
        let result: DialogResult = kind === "prompt" || kind === "saveChanges" || kind === "uploadConflict" ? null : false;
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          result =
            kind === "uploadConflict"
              ? { action: "keep-both", applyToRemaining: applyToRemaining.checked }
              : kind === "saveChanges"
                ? "save"
                : input
                  ? input.value
                  : true;
          dialog.close();
        });
        dialog.addEventListener(
          "close",
          () => {
            removeBackdropCancellation();
            dialog.remove();
            restoreFocus(previousFocus);
            resolve(kind === "alert" ? undefined : result);
          },
          { once: true },
        );
        // Mount only when this queued request is active, including above other modals.
        document.body.append(dialog);
        const initialFocus = input || (options.destructive && kind !== "alert" ? cancel : confirm);
        initialFocus.autofocus = true;
        try {
          dialog.showModal();
          initialFocus.focus();
          input?.select();
        } catch (error) {
          removeBackdropCancellation();
          dialog.remove();
          restoreFocus(previousFocus);
          reject(error);
        }
      }),
  );
  pending.set(key, task);
  queue = task.catch(() => {});
  task.then(
    () => pending.delete(key),
    () => pending.delete(key),
  );
  return task;
}

export function confirmDialog(message: string, options?: DialogOptions): Promise<boolean> {
  return showDialog("confirm", message, options) as Promise<boolean>;
}

export function promptDialog(message: string, options?: DialogOptions): Promise<string | null> {
  return showDialog("prompt", message, options) as Promise<string | null>;
}

export function saveChangesDialog(message: string, confirmLabel = "Save", discardLabel = "Discard"): Promise<"save" | "discard" | null> {
  return showDialog("saveChanges", message, { confirmLabel, discardLabel }) as Promise<"save" | "discard" | null>;
}

/** Dismissal returns null; callers must stop the remaining upload batch. */
export function uploadConflictDialog(path: string): Promise<UploadConflictResult | null> {
  return showDialog("uploadConflict", `A file already exists at “${path}”.\n\nReplace it, skip this upload, or keep both files with a new name.`, {
    confirmLabel: "Keep both",
    actionIcons: false,
  }) as Promise<UploadConflictResult | null>;
}

export function alertDialog(message: string, options?: DialogOptions): Promise<void> {
  return showDialog("alert", message, options) as Promise<void>;
}
