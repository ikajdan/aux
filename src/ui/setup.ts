// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { restoreFocus, installBackdropCancellation } from "../modal-dialogs.js";

const settingsKeys = ["token", "author", "email"] as const;
type SettingsKey = (typeof settingsKeys)[number];
interface SetupOptions {
  getSettings: () => Partial<Record<SettingsKey, string>>;
  validateToken: (token: string) => Promise<{ id: number }>;
  saveField: (key: SettingsKey) => boolean;
  persistTheme: () => void;
  refreshDocuments: () => Promise<unknown>;
}

interface SetupElements {
  "setup-dialog": HTMLDialogElement;
  "setup-token": HTMLInputElement;
  "setup-next": HTMLButtonElement;
  "setup-close": HTMLButtonElement;
}
function $<K extends keyof SetupElements>(id: K): SetupElements[K];
function $<T extends HTMLElement = HTMLElement>(id: string): T;
function $(id: string): HTMLElement {
  return document.getElementById(id);
}

export function createSetupDialog({ getSettings, validateToken, saveField, persistTheme, refreshDocuments }: SetupOptions) {
  return function openSetup() {
    const dialog = $("setup-dialog");
    const cards = [...dialog.querySelectorAll<HTMLElement>(".setup-card")];
    const steps = [...dialog.querySelectorAll<HTMLElement>(".setup-progress li")];
    let step = 0;
    let setupSubmitting = false;
    let setupTransitioning = false;
    let stepAnimations: Animation[] = [];
    try {
      localStorage.setItem("aux-setup-complete", "false");
    } catch (error) {
      console.warn("Could not mark setup incomplete", error);
    }
    $("setup-token").oninput = () => {
      $("setup-token").removeAttribute("aria-invalid");
      $("setup-token-error").textContent = "";
      $("setup-token-error").hidden = true;
      $("setup-status").textContent = "";
    };
    for (const key of settingsKeys) $<HTMLInputElement>(`setup-${key}`).value = getSettings()[key] || "";
    const background = [document.querySelector<HTMLElement>(".app-header"), document.querySelector("main")];
    for (const element of background) element.inert = true;
    dialog.oncancel = (event) => {
      if (setupSubmitting) event.preventDefault();
    };
    dialog.onkeydown = (event) => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      // Keep the header close action last without positive tabindex values.
      const controls = [
        ...cards[step].querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]"),
        $("setup-next"),
        $("setup-close"),
      ].filter(
        (control) =>
          control.tabIndex >= 0 &&
          !control.matches(":disabled") &&
          !control.closest("[hidden], [inert]") &&
          !control.closest("details:not([open])") &&
          control.getClientRects().length > 0,
      );
      event.preventDefault();
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const next = index < 0 ? (event.shiftKey ? controls.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
      (controls[next] || $("setup-status")).focus();
    };
    async function showStep(next: number) {
      const previous = step;
      const viewport = dialog.querySelector<HTMLElement>(".setup-viewport");
      const previousHeight = viewport.getBoundingClientRect().height;
      const animate = next !== previous && !matchMedia("(prefers-reduced-motion: reduce)").matches;
      step = next;
      dialog.dataset.step = String(step);
      cards.forEach((card, index) => {
        card.hidden = index !== step;
        card.inert = index !== step;
        card.setAttribute("aria-hidden", String(index !== step));
        steps[index].dataset.state = index < step ? "complete" : index === step ? "current" : "upcoming";
        steps[index].querySelector(".setup-step-marker").textContent = index < step ? "✓" : String(index + 1);
        if (index === step) steps[index].setAttribute("aria-current", "step");
        else steps[index].removeAttribute("aria-current");
      });
      $("setup-next-label").textContent = step === 2 ? "Finish setup" : "Next";
      $("setup-status").textContent = "";
      if (animate) {
        const nextHeight = viewport.getBoundingClientRect().height;
        cards[previous].hidden = false;
        setupTransitioning = true;
        $("setup-next").disabled = true;
        const timing = { duration: 360, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };
        stepAnimations = [
          cards[previous].animate(
            [
              { transform: "translateX(0)", opacity: 1 },
              { transform: "translateX(-30%)", opacity: 0 },
            ],
            { ...timing, fill: "forwards" },
          ),
          cards[step].animate(
            [
              { transform: "translateX(40%)", opacity: 0 },
              { transform: "translateX(0)", opacity: 1 },
            ],
            timing,
          ),
          viewport.animate([{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }], timing),
        ];
        await Promise.allSettled(stepAnimations.map((animation) => animation.finished));
        cards[previous].hidden = true;
        for (const animation of stepAnimations) animation.cancel();
        stepAnimations = [];
        setupTransitioning = false;
        $("setup-next").disabled = false;
      }
      if (dialog.open) restoreFocus(cards[step].querySelector("input, [aria-checked='true']"));
    }

    return new Promise<void>((resolve) => {
      const removeBackdropCancellation = installBackdropCancellation(dialog);
      dialog.addEventListener(
        "close",
        () => {
          removeBackdropCancellation();
          for (const animation of stepAnimations) animation.cancel();
          dialog.oncancel = null;
          dialog.onkeydown = null;
          $("setup-form").onsubmit = null;
          for (const element of background) element.inert = false;
          document.body.classList.remove("setup-pending");
          restoreFocus($("app-menu"));
          resolve();
        },
        { once: true },
      );
      $("setup-form").onsubmit = async (event) => {
        event.preventDefault();
        if (setupSubmitting || setupTransitioning) return;
        const keys: (typeof settingsKeys)[number][] = step === 0 ? ["token"] : step === 1 ? ["author", "email"] : [];
        let invalid;
        for (const key of keys) {
          const input = $<HTMLInputElement>(`setup-${key}`);
          input.value = input.value.trim();
          const message = !input.value
            ? { token: "Enter a personal access token.", author: "Enter an author name.", email: "Enter an email address." }[key]
            : !input.validity.valid
              ? "Enter a valid email address, such as name@example.com."
              : "";
          const error = $(`setup-${key}-error`);
          error.textContent = message;
          error.hidden = !message;
          if (message) {
            input.setAttribute("aria-invalid", "true");
            invalid ||= input;
          } else input.removeAttribute("aria-invalid");
        }
        if (invalid) {
          restoreFocus(invalid);
          return;
        }
        if (step === 0) {
          const input = $("setup-token");
          const candidate = input.value;
          setupSubmitting = true;
          $("setup-close").disabled = true;
          input.disabled = true;
          $("setup-next").disabled = true;
          $("setup-next-label").textContent = "Checking…";
          $("setup-status").textContent = "Checking token…";
          $("setup-status").focus();
          try {
            const user = await validateToken(candidate);
            if (!Number.isInteger(user?.id) || user.id <= 0) throw new Error("Invalid user response");
          } catch (error) {
            const message =
              error.status === 401
                ? "This token is invalid or expired. Enter a valid personal access token."
                : error.status === 403
                  ? "This token does not have permission to access the GitLab API. Check its permissions."
                  : "Could not validate the token. Check your connection and try again.";
            $("setup-token-error").textContent = message;
            $("setup-token-error").hidden = false;
            input.setAttribute("aria-invalid", "true");
            return;
          } finally {
            setupSubmitting = false;
            $("setup-close").disabled = false;
            input.disabled = false;
            $("setup-next").disabled = false;
            $("setup-next-label").textContent = "Next";
            $("setup-status").textContent = "";
            if (input.hasAttribute("aria-invalid")) restoreFocus(input);
          }
        }
        try {
          localStorage.setItem("aux-setup-complete", "false");
          for (const key of keys) {
            $<HTMLInputElement>(key).value = $<HTMLInputElement>(`setup-${key}`).value;
            if (!saveField(key)) throw new Error("Settings were not saved");
          }
          if (step === 2) {
            persistTheme();
            localStorage.setItem("aux-setup-complete", "true");
          }
        } catch (error) {
          console.warn("Could not save setup", error);
          $("setup-status").textContent = "Could not save setup in this browser. Try again.";
          return;
        }
        if (step === 0) {
          void refreshDocuments().catch(() => {
            console.warn("Could not load documents during setup. Refresh documents to try again.");
          });
        }
        if (step < 2) {
          await showStep(step + 1);
          return;
        }
        dialog.close();
      };
      dialog.showModal();
      void showStep(0);
    });
  };
}
