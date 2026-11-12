// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RepositoryGroup } from "./repository-groups.js";

export function projectGroupBadge(group: RepositoryGroup, groups: RepositoryGroup[], project?: { name?: string; path?: string; path_with_namespace?: string }) {
  const index = Math.max(
    0,
    groups.findIndex((entry) => entry.path === group.path),
  );
  const name = project ? project.name?.trim() || project.path || project.path_with_namespace?.split("/").pop() || "" : group.name;
  return {
    letter: Array.from(name.trim().toUpperCase())[0] || "?",
    tone: index % 6,
  };
}
