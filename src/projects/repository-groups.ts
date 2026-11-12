// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface RepositoryGroup {
  name: string;
  path: string;
}
interface GroupProject {
  id: string | number;
  path_with_namespace?: string;
}

export function repositoryGroupFor(project: GroupProject, groups: RepositoryGroup[]): RepositoryGroup | undefined {
  return groups.filter((group) => project.path_with_namespace?.startsWith(`${group.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

export function groupRepositories<T extends GroupProject>(projects: T[], groups: RepositoryGroup[]) {
  const buckets = groups.map((group) => ({ group, projects: [] as T[] }));
  const seen = new Set<string>();
  for (const project of projects) {
    const key = String(project.id);
    const group = repositoryGroupFor(project, groups);
    if (!group || seen.has(key)) continue;
    seen.add(key);
    buckets[groups.indexOf(group)].projects.push(project);
  }
  return buckets;
}

export async function fetchGroupRepositories<T extends GroupProject>(
  pages: (endpoint: string) => Promise<T[]>, groups: RepositoryGroup[],
): Promise<T[]> {
  const batches = await Promise.all(groups.map((group) => pages(
    `groups/${encodeURIComponent(group.path)}/projects?include_subgroups=true&with_shared=false&order_by=path&sort=asc`,
  )));
  return groupRepositories(batches.flat(), groups).flatMap(({ projects }) => projects);
}
