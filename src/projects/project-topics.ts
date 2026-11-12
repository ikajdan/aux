// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ProjectTopics {
  topics?: string[];
}

export function projectTopics(project: ProjectTopics): string[] {
  const seen = new Set<string>();
  return (Array.isArray(project.topics) ? project.topics : [])
    .filter((topic) => {
      if (typeof topic !== "string" || !topic.trim()) return false;
      const key = topic.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((topic) => topic.trim());
}

export function renderProjectTopics(container: HTMLElement, project: ProjectTopics) {
  container.replaceChildren(
    ...projectTopics(project).map((topic) => {
      const badge = document.createElement("span");
      badge.className = "repository-tag";

      badge.textContent = topic;
      return badge;
    }),
  );
}
