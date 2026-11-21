// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { StatusState } from "../application-types.js";
import { icon } from "../ui-icons.js";

interface StatusControllerOptions {
  content: HTMLElement;
  toast: HTMLElement;
  cancelBuild: HTMLElement;
  isBusy: () => boolean;
  getBuildOperation: () => { signal: { readonly aborted: boolean } } | null;
}

export function createStatusController({ content, toast, cancelBuild, isBusy, getBuildOperation }: StatusControllerOptions) {
  let statusTimer: ReturnType<typeof setTimeout>;
  let statusVersion = 0;

  function dismissStatus() {
    clearTimeout(statusTimer);
    statusVersion++;
    content.replaceChildren();
    cancelBuild.hidden = true;
    if (toast.matches(":popover-open")) toast.hidePopover();
    toast.hidden = true;
  }

  function formatStatusMessage(text: unknown, state: StatusState) {
    const message = String(text ?? "").trimEnd();
    if (!message || /[.!?…]["'’”)\]]*$/.test(message)) return message;
    return message + (state === "busy" ? "…" : ".");
  }

  function status(text: string, state: StatusState = isBusy() ? "busy" : "ready") {
    text = formatStatusMessage(text, state);
    if (!text) {
      dismissStatus();
      return;
    }
    clearTimeout(statusTimer);
    const version = ++statusVersion;
    if (content.dataset.state === state && content.lastChild?.nodeType === Node.TEXT_NODE) content.lastChild.textContent = text;
    else content.replaceChildren(icon(state), document.createTextNode(text));
    content.dataset.state = state;
    const buildOperation = getBuildOperation();
    cancelBuild.hidden = state !== "busy" || !buildOperation || buildOperation.signal.aborted;
    toast.hidden = false;
    if (!toast.matches(":popover-open")) toast.showPopover();
    if (text && (state === "ready" || state === "error")) {
      statusTimer = setTimeout(
        () => {
          if (version === statusVersion) dismissStatus();
        },
        state === "error" ? 8000 : 5000,
      );
    }
  }

  return {
    get version() { return statusVersion; },
    status,
    dismissStatus,
  };
}
