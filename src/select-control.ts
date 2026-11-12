// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { icon } from "./ui-icons.js";

let nextSelectId = 0;

export function createSelect(select: HTMLSelectElement) {
  const id = select.id || `custom-select-${++nextSelectId}`;
  const wrapper = document.createElement("div");
  wrapper.className = "custom-select";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.id = `${id}-trigger`;
  trigger.className = "custom-select-trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", `${id}-listbox`);
  const value = document.createElement("span");
  value.id = `${id}-value`;
  trigger.append(value, icon("chevron-down"));
  const popup = document.createElement("div");
  popup.id = `${id}-listbox`;
  popup.className = "custom-select-popup";
  popup.setAttribute("role", "listbox");
  popup.hidden = true;
  const labels = [...select.labels];
  const accessibleLabel = select.getAttribute("aria-label");
  const labelledBy = select.getAttribute("aria-labelledby");
  if (labelledBy) {
    trigger.setAttribute("aria-labelledby", labelledBy);
    popup.setAttribute("aria-labelledby", labelledBy);
  } else if (accessibleLabel) {
    trigger.setAttribute("aria-label", accessibleLabel);
    popup.setAttribute("aria-label", accessibleLabel);
  } else {
    const labelIds = labels.map((label, index) => (label.id ||= `${id}-label-${index}`));
    trigger.setAttribute("aria-labelledby", [...labelIds, value.id].join(" "));
    popup.setAttribute("aria-labelledby", labelIds.length ? labelIds.join(" ") : value.id);
  }
  select.before(wrapper);
  wrapper.append(select, trigger);
  select.hidden = true;
  const dialog = select.closest("dialog");
  const popupParent = dialog || document.body;
  popupParent.append(popup);
  dialog?.addEventListener("close", () => close());
  let active = -1;
  let choices: HTMLButtonElement[] = [];
  let prefix = "";
  let typedAt = 0;

  function close() {
    popup.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
    prefix = "";
  }

  function position() {
    if (popup.hidden) return;
    const rect = trigger.getBoundingClientRect();
    const below = Math.max(0, innerHeight - rect.bottom - 8);
    const above = Math.max(0, rect.top - 8);
    const upwards = below < 160 && above > below;
    const height = Math.min(256, upwards ? above : below);
    const width = Math.min(Math.max(rect.width, 180), innerWidth - 16);
    popup.style.width = `${width}px`;
    popup.style.maxHeight = `${height}px`;
    popup.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
    popup.style.top = upwards ? "auto" : `${rect.bottom + 4}px`;
    popup.style.bottom = upwards ? `${innerHeight - rect.top + 4}px` : "auto";
  }

  function highlight(index: number) {
    active = choices[index] && !choices[index].disabled && !choices[index].hidden ? index : -1;
    choices.forEach((choice, i) => choice.classList.toggle("is-active", i === active));
    if (choices[active]) {
      trigger.setAttribute("aria-activedescendant", choices[active].id);
      choices[active].scrollIntoView({ block: "nearest" });
    } else trigger.removeAttribute("aria-activedescendant");
  }

  function sync() {
    value.textContent = select.selectedOptions[0]?.textContent || "Select a branch";
    trigger.disabled = select.disabled || !select.options.length;
    choices.forEach((choice, i) => {
      const option = select.options[i];
      const group = option.parentElement?.closest("optgroup");
      choice.disabled = option.disabled || !!group?.disabled;
      choice.hidden = option.hidden || !!group?.hidden;
      choice.style.display = choice.hidden ? "none" : "";
      choice.setAttribute("aria-selected", String(i === select.selectedIndex));
    });
    if (!popup.hidden) highlight(active);
    if (trigger.disabled) close();
  }

  function open(index = select.selectedIndex) {
    if (trigger.disabled) return;
    trigger.focus();
    popup.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    position();
    const initial = Math.max(0, index);
    highlight(choices[initial]?.disabled || choices[initial]?.hidden ? choices.findIndex((choice) => !choice.disabled && !choice.hidden) : initial);
  }

  function choose(index: number) {
    if (trigger.disabled || !choices[index] || choices[index].disabled || choices[index].hidden) return;
    select.selectedIndex = index;
    sync();
    close();
    trigger.focus();
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function rebuild() {
    close();
    choices = [...select.options].map((option, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.id = `${id}-option-${index}`;
      button.tabIndex = -1;
      button.setAttribute("role", "option");
      button.textContent = option.textContent;
      button.disabled = option.disabled;
      button.hidden = option.hidden;
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", () => choose(index));
      return button;
    });
    popup.replaceChildren(...choices);
    sync();
  }

  trigger.addEventListener("click", () => (popup.hidden ? open() : close()));
  trigger.addEventListener("keydown", (event) => {
    if (trigger.disabled) return;
    const key = event.key;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) {
      event.preventDefault();
      const direction = key === "ArrowUp" || key === "End" ? -1 : 1;
      let index =
        key === "Home"
          ? 0
          : key === "End"
            ? choices.length - 1
            : popup.hidden
              ? Math.max(0, select.selectedIndex)
              : active < 0
                ? direction > 0
                  ? 0
                  : choices.length - 1
                : active + direction;
      while (index >= 0 && index < choices.length && (choices[index].disabled || choices[index].hidden)) index += direction;
      if (index < 0 || index >= choices.length) index = popup.hidden ? -1 : active;
      if (popup.hidden) open(index);
      else highlight(index);
    } else if (key === "Enter" || key === " ") {
      event.preventDefault();
      if (popup.hidden) open();
      else choose(active);
    } else if (key === "Escape") {
      if (!popup.hidden) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    } else if (key === "Tab") close();
    else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      prefix = now - typedAt < 700 ? prefix + key.toLowerCase() : key.toLowerCase();
      typedAt = now;
      const index = choices.findIndex((choice) => !choice.disabled && !choice.hidden && choice.textContent.toLowerCase().startsWith(prefix));
      if (index >= 0) {
        if (popup.hidden) open(index);
        else highlight(index);
      }
    }
  });
  for (const label of labels)
    label.addEventListener("click", (event) => {
      if (wrapper.contains(event.target as Node)) return;
      event.preventDefault();
      trigger.focus();
    });
  document.addEventListener("pointerdown", (event) => {
    if (!wrapper.contains(event.target as Node) && !popup.contains(event.target as Node)) close();
  });
  document.addEventListener("focusin", (event) => {
    if (!wrapper.contains(event.target as Node) && !popup.contains(event.target as Node)) close();
  });
  window.addEventListener("resize", position);
  document.addEventListener(
    "scroll",
    (event) => {
      if (!popup.contains(event.target as Node)) position();
    },
    true,
  );
  select.addEventListener("change", sync);
  rebuild();
  return {
    close,
    sync,
    rebuild,
    setValue(value: string) {
      select.value = value;
      sync();
    },
    setOptions(names: string[]) {
      select.replaceChildren(
        ...names.map((name) => {
          const option = document.createElement("option");
          option.value = option.textContent = name;
          return option;
        }),
      );
      rebuild();
    },
  };
}
