// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

interface ThemeOptions {
  root: HTMLElement;
  groups: HTMLElement[];
  savedThemeValue: string;
  media: (query: string) => MediaQueryList;
  storage: Pick<Storage, "setItem">;
  setupStatus: HTMLElement;
  reportSettingsError: (message: string) => void;
}

export function createThemeController({ root, groups, savedThemeValue, media, storage, setupStatus, reportSettingsError }: ThemeOptions) {
  const systemTheme = media("(prefers-color-scheme: dark)");
  const savedTheme = savedThemeValue;
  let selectedTheme = ["light", "dark"].includes(savedTheme) ? savedTheme : "system";
  root.dataset.theme = selectedTheme;
  const themeGroups = [...groups];
  let setEditorTheme: (theme: string) => void;
  function applyTheme() {
    root.dataset.theme = selectedTheme;
    setEditorTheme(selectedTheme === "system" ? (systemTheme.matches ? "dark" : "light") : selectedTheme);
    for (const group of themeGroups) {
      for (const [index, button] of [...group.querySelectorAll<HTMLElement>("[data-theme-choice]")].entries()) {
        const active = button.dataset.themeChoice === selectedTheme;
        button.setAttribute("aria-checked", String(active));
        button.tabIndex = active ? 0 : -1;
        if (active) group.dataset.activeIndex = String(index);
      }
    }
  }
  function selectTheme(value: string) {
    storage.setItem("aux-theme", value);
    selectedTheme = value;
    applyTheme();
  }
  return {
    get selectedTheme() { return selectedTheme; },
    selectTheme,
    connectEditor(apply: (theme: string) => void) {
      setEditorTheme = apply;
      applyTheme();
      systemTheme.addEventListener("change", applyTheme);
      for (const group of themeGroups) {
        const themeButtons = [...group.querySelectorAll<HTMLElement>("[data-theme-choice]")];
        function chooseTheme(button: HTMLElement, focus = false) {
          try {
            selectTheme(button.dataset.themeChoice);
            if (focus) button.focus();
            setupStatus.textContent = "";
          } catch (error) {
            console.warn("Could not save theme", error);
            if (group.closest("#setup-dialog")) setupStatus.textContent = "Could not save appearance. Try again.";
            else reportSettingsError("Could not save appearance. Try again.");
          }
        }
        for (const [index, button] of themeButtons.entries()) {
          button.onclick = () => chooseTheme(button);
          button.onkeydown = (event: KeyboardEvent) => {
            let next;
            if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % themeButtons.length;
            else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + themeButtons.length - 1) % themeButtons.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = themeButtons.length - 1;
            else return;
            event.preventDefault();
            chooseTheme(themeButtons[next], true);
          };
        }
      }
    },
  };
}
