// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { fetchSnapshot, type SnapshotProgress } from "../gitlab-submodules.js";
import { changedActions, type GitLabAPI, type RepositorySnapshot } from "../gitlab-sync.js";
import type { ServerConfig } from "../server-config.js";
import { materializeSymlinkFiles } from "../workspace/symlink-files.js";
import { validateRequestSize } from "../workspace/snapshot-limits.js";

type TemplateProject = { id: number; default_branch?: string; visibility: "private" | "internal" | "public" };

export async function prepareTemplateProject(
  api: GitLabAPI,
  config: ServerConfig,
  onProgress: (progress: SnapshotProgress) => void,
) {
  const template = await api.request<TemplateProject>(`projects/${encodeURIComponent(config.templateRepository)}`);
  if (!template.default_branch) throw new Error("The template repository has no default branch.");
  if (!["private", "internal", "public"].includes(template.visibility)) {
    throw new Error("Could not determine the template's visibility.");
  }
  const branch = template.default_branch;
  const head = await api.request<{ commit: { id: string } }>(
    `projects/${template.id}/repository/branches/${encodeURIComponent(branch)}`,
  );
  const snapshot = await fetchSnapshot(api, template.id, head.commit.id, config.templateRepository, config.limits, onProgress);
  const modes = new Map(snapshot.files.map((file) => [file.path, file.mode]));
  const files = materializeSymlinkFiles(snapshot.files, config.limits);
  // Materialized submodules no longer have gitlinks, so their mapping files are obsolete.
  const moduleFiles = new Set(snapshot.links.length ? [".gitmodules", ...snapshot.links.map((link) => `${link.path}/.gitmodules`)] : []);
  const current: RepositorySnapshot = Object.create(null);
  for (const file of files) {
    if (moduleFiles.has(file.path)) continue;
    current[file.path] = { oid: "", bytes: file.bytes, mode: modes.get(file.path) === "100755" ? "100755" : "100644" };
  }
  const actions = changedActions({}, current);
  if (!actions.length) throw new Error("The template repository has no files to copy.");
  const commit = { branch, commit_message: "Initialize document from template", actions };
  validateRequestSize(JSON.stringify(commit), config.limits);
  return { branch, visibility: template.visibility, commit };
}
