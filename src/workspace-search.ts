// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { icon } from "./ui-icons.js";

export interface WorkspaceMatch {
  line: number;
  column: number;
  text: string;
  length: number;
}

export interface SearchRepository {
  dir: string;
  files(): Promise<string[]>;
  p: { readFile(path: string): Promise<Uint8Array<ArrayBufferLike>> };
}

export interface WorkspaceSearchOptions {
  panel: HTMLElement;
  input: HTMLInputElement;
  status: HTMLElement;
  results: HTMLElement;
  context(): { repo: SearchRepository; saved: Promise<unknown>; path: string; text: string } | null;
  open(repo: SearchRepository, path: string, match: WorkspaceMatch): void | Promise<void>;
}

export function createWorkspaceSearch({ panel, input, status, results, context, open }: WorkspaceSearchOptions) {
  const required = {
    "project-search-panel": panel,
    "workspace-search": input,
    "workspace-search-status": status,
    "workspace-search-results": results,
  };
  const invalid = Object.entries(required)
    .filter(([, element]) => !element || !panel || !panel.contains(element))
    .map(([id]) => `#${id}`);
  if (input && (input.tagName !== "INPUT" || input.type !== "search")) invalid.push("#workspace-search (expected a search input)");
  if (invalid.length) {
    const error = new Error(`Workspace search unavailable: missing or misplaced ${invalid.join(", ")}`);
    console.error(error);
    if (panel) {
      const message = document.createElement("p");
      message.setAttribute("role", "status");
      message.textContent = error.message;
      panel.append(message);
    }
    if (input) input.disabled = true;
    return { available: false, refresh() {} };
  }
  let generation = 0;
  let timer: ReturnType<typeof setTimeout>;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  function refresh() {
    clearTimeout(timer);
    const token = ++generation;
    results.replaceChildren();
    status.textContent = input.value ? "Searching…" : "";
    if (input.value) timer = setTimeout((): void => void search(token), 250);
  }
  async function search(token: number) {
    const source = context();
    const current = () => token === generation && source?.repo === context()?.repo;
    if (!source) {
      status.textContent = "Open a workspace to search.";
      return;
    }
    const query = input.value;
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const groups: { path: string; matches: WorkspaceMatch[] }[] = [];
    let count = 0;
    let unreadable = 0;
    try {
      await source.saved.catch(() => {});
      for (const path of await source.repo.files()) {
        if (!current()) return;
        let text: string;
        try {
          const bytes = await source.repo.p.readFile(`${source.repo.dir}/${path}`);
          if (!current()) return;
          try {
            text = decoder.decode(bytes);
          } catch {
            continue;
          }
          if (text.includes("\0")) continue;
          if (path === source.path) text = source.text;
        } catch {
          unreadable++;
          continue;
        }
        const matches: WorkspaceMatch[] = [];
        for (const [index, line] of text.split(/\r\n|\r|\n/).entries()) {
          pattern.lastIndex = 0;
          let match: RegExpExecArray;
          while ((match = pattern.exec(line))) {
            matches.push({ line: index + 1, column: match.index + 1, text: line, length: match[0].length });
          }
        }
        if (matches.length) {
          groups.push({ path, matches });
          count += matches.length;
        }
        // Yield between files so typing and cancellation remain responsive.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (!current()) return;
      status.textContent = count ? `${count} match${count === 1 ? "" : "es"} in ${groups.length} file${groups.length === 1 ? "" : "s"}.` : "No results found.";
      if (unreadable) status.textContent += ` ${unreadable} file(s) could not be read.`;
      const content = document.createElement("div");
      content.className = "workspace-search-content";
      results.replaceChildren(content);
      let groupIndex = 0;
      let matchIndex = 0;
      let list: HTMLUListElement;
      const more = document.createElement("button");
      more.type = "button";
      more.className = "workspace-search-more";
      more.textContent = "Load more matches";
      more.prepend(icon("chevron-down"));
      function page() {
        more.remove();
        let remaining = 200;
        while (groupIndex < groups.length && remaining--) {
          const group = groups[groupIndex];
          if (!matchIndex) {
            const section = document.createElement("section");
            const heading = document.createElement("h3");
            heading.textContent = `${group.path} (${group.matches.length})`;
            list = document.createElement("ul");
            section.append(heading, list);
            content.append(section);
          }
          const match = group.matches[matchIndex++];
          const item = document.createElement("li");
          const button = document.createElement("button");
          button.type = "button";
          button.setAttribute("aria-label", `${group.path}, line ${match.line}, column ${match.column}: ${match.text}`);
          const start = Math.max(0, match.column - 1 - 60);
          const end = Math.min(match.text.length, match.column - 1 + match.length + 120);
          const mark = document.createElement("mark");
          mark.textContent = match.text.slice(match.column - 1, match.column - 1 + match.length);
          button.append(
            `${match.line}:${match.column}  ${start ? "…" : ""}${match.text.slice(start, match.column - 1)}`,
            mark,
            `${match.text.slice(match.column - 1 + match.length, end)}${end < match.text.length ? "…" : ""}`,
          );
          button.onclick = async () => {
            if (!current()) return;
            try {
              await open(source.repo, group.path, match);
            } catch (error) {
              if (current()) status.textContent = `Could not open result: ${error.message}`;
            }
          };
          item.append(button);
          list.append(item);
          if (matchIndex === group.matches.length) {
            groupIndex++;
            matchIndex = 0;
          }
        }
        if (groupIndex < groups.length) content.append(more);
      }
      more.onclick = page;
      page();
    } catch (error) {
      if (current()) status.textContent = `Search failed: ${error.message}`;
    }
  }
  input.addEventListener("input", refresh);
  return { available: true, refresh };
}
