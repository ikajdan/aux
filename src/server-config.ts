// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RepositoryGroup } from "./projects/repository-groups.js";

export interface SnapshotLimits {
  requestBytes: number;
  snapshotBytes: number;
  snapshotFiles: number;
  snapshotEntries: number;
  submoduleDepth: number;
}

export interface ServerConfig {
  gitlabUrl: string;
  repositoryGroups: RepositoryGroup[];
  limits: SnapshotLimits;
  maxConcurrentBuilds: number;
  mainDocument: string;
}
export let serverConfig: ServerConfig;

export async function loadServerConfig() {
  const response = await fetch("/config", { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load server configuration (HTTP ${response.status}).`);
  const config: ServerConfig = await response.json();

  serverConfig = config;
}
