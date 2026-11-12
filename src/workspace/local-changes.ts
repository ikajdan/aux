// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

interface WorkspaceReference {
  project: string | number;
  branch: string;
  dir: string;
}
interface LocalChangeState {
  dirty: boolean;
  draft?: boolean;
  dirtyKnown?: boolean;
  unpublished: boolean;
  known?: boolean;
  pending: number;
  errors: ReadonlySet<string>;
}

export function localChangeBranches(
  projectId: string | number,
  workspaces: Iterable<WorkspaceReference>,
  warnings: ReadonlyMap<string, LocalChangeState>,
): string[] {
  const branches = new Set<string>();
  for (const workspace of workspaces) {
    if (String(workspace.project) !== String(projectId)) continue;
    const state = warnings.get(workspace.dir);
    if (state && (state.draft || (state.dirtyKnown && state.dirty) || state.pending > 0 || state.errors.size > 0 || (state.known && state.unpublished)))
      branches.add(workspace.branch);
  }
  return [...branches];
}
