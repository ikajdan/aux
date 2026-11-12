// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ShortcutHandlers {
  ready: () => boolean;
  saveAndBuild: () => unknown;
  files: () => unknown;
  sync: () => unknown;
  preview: () => unknown;
  logs: () => unknown;
  search: () => unknown;
}
export interface ShortcutDescription {
  group: string;
  label: string;
  keys: string;
}
export interface ShortcutCommand extends ShortcutDescription {
  match: (event: KeyboardEvent) => boolean;
  run: () => unknown;
  enabled?: () => boolean;
}

export function installShortcuts({ ready, saveAndBuild, files, sync, preview, logs, search }: ShortcutHandlers) {
  const commands: ShortcutCommand[] = [
    {
      group: "Editing",
      label: "Save and build",
      keys: "Ctrl + S",
      match: (e) => mod(e) && !e.shiftKey && key(e, "s"),
      run: saveAndBuild,
    },
    { group: "Navigation", label: "Files", keys: "Alt + 1", match: (e) => alt(e, "Digit1"), run: files },
    { group: "Navigation", label: "Search all files", keys: "Alt + 2", match: (e) => alt(e, "Digit2"), run: search },
    { group: "Navigation", label: "Sync", keys: "Alt + 3", match: (e) => alt(e, "Digit3"), run: sync },
    { group: "Navigation", label: "Preview", keys: "Alt + 4", match: (e) => alt(e, "Digit4"), run: preview },
    { group: "Navigation", label: "Logs", keys: "Alt + 5", match: (e) => alt(e, "Digit5"), run: logs },
    {
      group: "Editing",
      label: "Search all files",
      keys: "Ctrl + Shift + F",
      match: (e) => mod(e) && e.shiftKey && key(e, "f"),

      run: search,
    },
  ];
  const groups = new Map<string, ShortcutDescription[]>();
  for (const row of [
    ...commands.filter((command) => command.run === saveAndBuild),

    { group: "Editing", label: "Find in the editor", keys: "Ctrl + F" },
    { group: "Editing", label: "Find and replace in the editor", keys: "Ctrl + H" },
    { group: "Editing", label: "Delete the current line", keys: "Ctrl + Shift + K" },
    { group: "Editing", label: "Indent / unindent in the editor", keys: "Tab / Shift + Tab" },
    { group: "Editing", label: "Comment / uncomment lines", keys: "Ctrl + /" },
    { group: "Editing", label: "Bold selection or word in the editor", keys: "Ctrl + B" },
    { group: "Editing", label: "Italicize selection or word in the editor", keys: "Ctrl + I" },
    { group: "Editing", label: "Monospace selection or word in the editor", keys: "Ctrl + Shift + X" },
    { group: "Editing", label: "Insert display math in the editor", keys: "Ctrl + Shift + M" },
    ...commands.filter((command) => command.group === "Editing" && command.run !== saveAndBuild),
    ...commands.filter((command) => command.group === "Navigation"),
  ]) {
    if (!groups.has(row.group)) groups.set(row.group, []);
    groups.get(row.group).push(row);
  }
  const content = document.getElementById("shortcut-groups");
  for (const [name, rows] of groups) {
    const section = document.createElement("section");
    section.className = "settings-group";
    const heading = document.createElement("h3");
    heading.textContent = name;
    const list = document.createElement("dl");
    list.className = "shortcut-list";
    for (const row of rows) {
      const label = document.createElement("dt");
      label.textContent = row.label;
      const value = document.createElement("dd");
      for (const part of row.keys.split(/(\s+[+/]\s+)/)) {
        if (!part.trim()) continue;
        if (/^\s+[+/]\s+$/.test(part)) {
          value.append(document.createTextNode(` ${part.trim()} `));
        } else {
          const key = document.createElement("kbd");
          key.textContent = part.trim();
          value.append(key);
        }
      }
      list.append(label, value);
    }
    section.append(heading, list);
    content.append(section);
  }
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || !ready() || document.querySelector("dialog[open], [role='menu']")) return;
    const command = commands.find((command) => command.match(event));
    if (!command || (command.enabled && !command.enabled())) return;
    event.preventDefault();
    if (!event.repeat) command.run();
  });
}

const key = (event: KeyboardEvent, value: string) => event.key.toLowerCase() === value;
const mod = (event: KeyboardEvent) => (event.ctrlKey || event.metaKey) && !event.altKey;

const alt = (event: KeyboardEvent, code: string) => event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === code;
