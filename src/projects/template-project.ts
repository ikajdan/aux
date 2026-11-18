// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ApplicationProject } from "../application.js";
import type { GitLabAPI } from "../gitlab-sync.js";
import type { ServerConfig } from "../server-config.js";

type ForkProject = ApplicationProject & { import_status?: string; import_error?: string; empty_repo?: boolean };

export async function prepareTemplateProject(api: GitLabAPI, config: ServerConfig) {
  const template = await api.request<{ id: number; default_branch?: string; visibility: "private" | "internal" | "public" }>(
    `projects/${encodeURIComponent(config.templateRepository)}`,
  );
  if (!Number.isSafeInteger(template.id) || template.id <= 0) throw new Error("Could not determine the template project ID.");
  if (!template.default_branch) throw new Error("The template repository has no default branch.");
  if (!["private", "internal", "public"].includes(template.visibility)) {
    throw new Error("Could not determine the template's visibility.");
  }
  return { id: template.id, branch: template.default_branch, visibility: template.visibility };
}

export async function waitForTemplateProject(api: GitLabAPI, projectId: string | number, timeoutMs = 60000): Promise<ForkProject | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const project = await api.request<ForkProject>(`projects/${encodeURIComponent(projectId)}`);
    if (project.import_status === "failed") throw new Error(project.import_error || "GitLab repository creation failed.");
    if (project.default_branch && !project.empty_repo && ["", "none", "finished"].includes(project.import_status || "")) return project;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, remaining)));
  }
}
