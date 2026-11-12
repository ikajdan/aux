// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ApplicationProject, ApplicationWorkspace } from "./application.js";

// Resolve storage inside the guard: accessing the browser's getter can itself throw.
export function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function readStoredJSON(key: string): unknown {
  try {
    return JSON.parse(readStorage(key) ?? "null");
  } catch {
    return null;
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function projectId(value: unknown): value is string | number {
  return (typeof value === "string" && value.trim().length > 0) || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
export function loadSettings() {
  const value = readStoredJSON("aux-settings");
  const settings: { token?: string; author?: string; email?: string; paneRatio?: number; customRepositories?: string[] } = {};
  if (!record(value)) return settings;
  for (const key of ["token", "author", "email"] as const) if (typeof value[key] === "string") settings[key] = value[key];
  if (typeof value.paneRatio === "number" && Number.isFinite(value.paneRatio) && value.paneRatio >= 20 && value.paneRatio <= 80)
    settings.paneRatio = value.paneRatio;
  if (Array.isArray(value.customRepositories) && value.customRepositories.every((path) => typeof path === "string"))
    settings.customRepositories = value.customRepositories;
  return settings;
}
export function loadProjects(): ApplicationProject[] {
  const value = readStoredJSON("aux-projects");
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is ApplicationProject =>
      record(item) &&
      projectId(item.id) &&
      typeof item.path_with_namespace === "string" &&
      item.path_with_namespace.length > 0 &&
      ["name", "path", "default_branch", "last_activity_at", "updated_at", "marked_for_deletion_at", "marked_for_deletion_on"].every(
        (key) => item[key] == null || typeof item[key] === "string",
      ) &&
      (item.latestTag == null || typeof item.latestTag === "string") &&
      (item.topics == null || (Array.isArray(item.topics) && item.topics.every((topic) => typeof topic === "string"))) &&
      (item.pending_delete == null || typeof item.pending_delete === "boolean"),
  );
}
function validPublication(value: unknown) {
  return record(value) && ["localHead", "branch", "remoteCommit"].every((field) => typeof value[field] === "string" && value[field].length > 0);
}
export function loadWorkspaces(): Record<string, ApplicationWorkspace> {
  const value = readStoredJSON("aux-workspaces");
  const workspaces: Record<string, ApplicationWorkspace> = Object.create(null);
  if (!record(value)) return workspaces;
  for (const [key, item] of Object.entries(value)) {
    if (
      !record(item) ||
      !projectId(item.project) ||
      !["branch", "dir", "remote", "base"].every((field) => typeof item[field] === "string" && item[field].length > 0) ||
      key !== `${item.project}:${item.branch}` ||
      (item.publication !== undefined && !validPublication(item.publication)) ||
      (item.modes !== undefined && (!record(item.modes) || !Object.values(item.modes).every((mode) => typeof mode === "string"))) ||
      (item.links !== undefined &&
        (!Array.isArray(item.links) ||
          !item.links.every(
            (link) =>
              record(link) && typeof link.path === "string" && typeof link.oid === "string" && (link.project === undefined || typeof link.project === "string"),
          )))
    )
      continue;
    workspaces[key] = { ...item, modes: item.modes ?? {} } as unknown as ApplicationWorkspace;
  }
  return workspaces;
}
