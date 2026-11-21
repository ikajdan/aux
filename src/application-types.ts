// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CatalogProject } from "./projects/catalog-view.js";
import type { Repository } from "./git-repository.js";
import type { PaneLayoutSettings } from "./workspace/pane-layout.js";
import type { IconName } from "./ui-icons.js";

export type ProjectId = string | number;
export interface RemoteBranch {
  name: string;
  commit: { id: string };
}
export interface ApplicationProject extends CatalogProject {
  default_branch?: string;
  pending_delete?: boolean;
  marked_for_deletion_at?: string;
  marked_for_deletion_on?: string;
}
export interface ApplicationWorkspace {
  project: ProjectId;
  branch: string;
  dir: string;
  remote: string;
  base: string;
  publication?: { localHead: string; branch: string; remoteCommit: string };
  modes: Record<string, string>;
  links?: Repository["links"];
}
export interface WorkspaceWarning {
  dirty: boolean;
  unpublished: boolean;
  unpublishedCount?: number;
  pending: number;
  errors: Set<string>;
  version: number;
  known?: boolean;
  dirtyKnown?: boolean;
  draft?: boolean;
}
export interface ActiveDocument {
  projectId: ProjectId;
  branch: string;
  filePath?: string;
}
export interface NavigationState extends Partial<ActiveDocument> {
  session: string;
  index: number;
  view: string;
  project?: ApplicationProject;
  dir?: string;
}
export interface OperationOptions {
  initialProgress?: boolean;
  completion?: boolean;
  transient?: boolean;
  allowSaveFailure?: boolean;
}
export type OperationResult = void | boolean | { statusHandled: boolean };
export type Operation = () => OperationResult | Promise<OperationResult>;
export type Settings = PaneLayoutSettings & { token?: string; author?: string; email?: string; customRepositories?: string[]; [key: string]: unknown };
export type StatusState = "busy" | "ready" | "error";
export type WorkspaceStatusKind = "changes";
export interface WorkspaceIndicator {
  label: string;
  branches: string[];
  kind: WorkspaceStatusKind;
  icon: IconName;
  detail: string;
}

