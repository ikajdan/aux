// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CommitAction, GitLabAPI } from "./gitlab-sync.js";

export interface MergeRequestPublication {
  source: string;
  target: string;
  title: string;
  commit: string;
}
export interface MergeRequestResult {
  iid: number;
  web_url: string;
}

export async function getProjectDefaultBranch(api: GitLabAPI, project: string | number): Promise<string> {
  const details = await api.request<{ default_branch?: string }>(`projects/${encodeURIComponent(project)}`);
  const branch = typeof details.default_branch === "string" ? details.default_branch.trim() : "";
  if (!branch) throw new Error("This project has no default branch configured in GitLab.");
  return branch;
}

export async function findOpenMergeRequest(api: GitLabAPI, project: string | number, branch: string): Promise<MergeRequestResult | null> {
  const requests = await api.pages<
    MergeRequestResult & {
      state: string;
      source_branch: string;
      source_project_id: number;
      target_project_id: number;
    }
  >(`projects/${encodeURIComponent(project)}/merge_requests?state=opened&scope=all&source_branch=${encodeURIComponent(branch)}`);
  return (
    requests.find((request) => request.state === "opened" && request.source_branch === branch && request.source_project_id === request.target_project_id) ??
    null
  );
}

export async function hasOpenMergeRequest(api: GitLabAPI, project: string | number, branch: string): Promise<boolean> {
  return (await findOpenMergeRequest(api, project, branch)) !== null;
}

export function validateMergeRequestBranch(source: string, target: string) {
  if (!source || source === target) throw new Error("Choose a new branch different from the current branch.");
  if (
    source === "@" ||
    /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(source) ||
    source.includes("..") ||
    source.includes("@{") ||
    source.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock")) ||
    source.startsWith("-")
  )
    throw new Error("Enter a valid Git branch name.");
}

export async function publishMergeRequestBranch(
  api: GitLabAPI,
  project: string | number,
  source: string,
  target: string,
  baseline: string,
  message: string,
  author: { name: string; email: string },
  actions: CommitAction[],
): Promise<string> {
  validateMergeRequestBranch(source, target);
  const root = `projects/${encodeURIComponent(project)}/repository`;
  const remote = await api.request<{ commit: { id: string } }>(`${root}/branches/${encodeURIComponent(target)}`);
  if (remote.commit.id !== baseline) throw new Error("Current branch has changed in GitLab. Pull/reconcile before pushing.");
  // Reserve the name first: the commits API alone can silently use an existing branch.
  try {
    await api.request(`${root}/branches`, { branch: source, ref: baseline });
  } catch (error) {
    throw new Error(
      `Could not reserve new branch ${source}. No commit was sent. If the request timed out, the branch may exist; inspect GitLab or choose another name. ${error.message}`,
    );
  }
  try {
    const guardedActions = await Promise.all(
      actions.map(async (action) => {
        if (action.action !== "update" && action.action !== "delete") return action;
        const file = await api.request<{ last_commit_id: string }>(`${root}/files/${encodeURIComponent(action.file_path)}?ref=${baseline}`);
        return { ...action, last_commit_id: file.last_commit_id };
      }),
    );
    const reserved = await api.request<{ commit: { id: string } }>(`${root}/branches/${encodeURIComponent(source)}`);
    if (reserved.commit.id !== baseline) throw new Error("New branch changed before publication. No commit sent.");
    const result = await api.request<{ id: string }>(`${root}/commits`, {
      branch: source,
      commit_message: message,
      author_name: author.name,
      author_email: author.email,
      actions: guardedActions,
    });
    return result.id;
  } catch (error) {
    throw new Error(
      `Branch ${source} was created, but publishing could not be confirmed. Local work is retained. Inspect the branch in GitLab or use a different new name; Aux will not overwrite it. ${error.message}`,
    );
  }
}

export async function createMergeRequest(api: GitLabAPI, project: string | number, publication: MergeRequestPublication): Promise<MergeRequestResult> {
  const root = `projects/${encodeURIComponent(project)}`;
  const query = `state=opened&scope=all&source_branch=${encodeURIComponent(publication.source)}&target_branch=${encodeURIComponent(publication.target)}`;
  // Recover from a lost POST response without creating a second MR.
  const requests = await api.pages<
    MergeRequestResult & {
      state: string;
      source_branch: string;
      target_branch: string;
      source_project_id: number;
      target_project_id: number;
    }
  >(`${root}/merge_requests?${query}`);
  const existing = requests.find(
    (request) =>
      request.state === "opened" &&
      request.source_branch === publication.source &&
      request.target_branch === publication.target &&
      request.source_project_id != null &&
      request.source_project_id === request.target_project_id,
  );
  if (existing) return existing;
  const branch = await api.request<{ commit: { id: string } }>(`${root}/repository/branches/${encodeURIComponent(publication.source)}`);
  if (branch.commit.id !== publication.commit) throw new Error("Published source branch changed in GitLab. Review it before creating the merge request.");
  return api.request<MergeRequestResult>(`${root}/merge_requests`, {
    source_branch: publication.source,
    target_branch: publication.target,
    title: publication.title,
  });
}
