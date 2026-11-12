// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { groupRepositories, repositoryGroupFor } from "./repository-groups.js";
import type { RepositoryGroup } from "./repository-groups.js";

interface CustomProject {
  id: string | number;
  path_with_namespace?: string;
}

export const customRepositoryGroup: RepositoryGroup = { name: "My repositories", path: "" };

export function sanitizeCustomRepositoryUrls(text: string): string {
  return text.replace(/^([\t ]*https:\/\/[^\r\n#]*)#[^\r\n]*/gim, "$1");
}

export function parseCustomRepositories(text: string, gitlabUrl: string): string[] {
  if (!text.trim()) return [];

  const safePath = (value: string): string => {
    const segments = value
      .replace(/\/$/, "")
      .split("/")
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          throw new Error("Fix the malformed percent encoding in the repository path, or paste the plain namespace/project path.");
        }
      });
    if (segments.some((segment) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(segment))) {
      throw new Error(
        "Use namespace/project paths with letters, numbers, underscores, hyphens or dots; empty, traversal and encoded slash segments are not allowed.",
      );
    }
    return segments.join("/");
  };
  const projectUrl = (value: string): { url: URL; path: string } => {
    if (!/^https:\/\//i.test(value) || /[\\\s?#]/.test(value)) {
      throw new Error("Use an HTTPS project URL without whitespace, backslashes, a query or a fragment.");
    }
    const url = new URL(value);
    if (url.username || url.password || value.slice(8).split("/")[0].includes("@")) {
      throw new Error("Remove user information or credentials from the project URL.");
    }
    // Inspect the original pathname: URL would silently resolve dot segments.
    const rawPath = value.match(/^https:\/\/[^/]*(\/.*)?$/i)?.[1] || "/";
    return { url, path: rawPath === "/" ? "" : safePath(rawPath.slice(1)) };
  };

  let configured: ReturnType<typeof projectUrl>;
  try {
    configured = projectUrl(gitlabUrl);
  } catch (error) {
    throw new Error(`Invalid configured GitLab URL: ${error.message}`);
  }

  const paths = new Set<string>();
  for (const [index, line] of sanitizeCustomRepositoryUrls(text).split(/\r?\n/).entries()) {
    const entry = line.trim();
    if (!entry) continue;
    try {
      let path: string;
      let namespace = entry.endsWith("/");
      if (/^https:\/\//i.test(entry)) {
        const candidate = projectUrl(entry);
        if (candidate.url.origin !== configured.url.origin) {
          throw new Error(`Use a project URL on ${configured.url.origin}, not ${candidate.url.origin}.`);
        }
        if (configured.path && !candidate.path.startsWith(`${configured.path}/`)) {
          throw new Error(`Use a project URL under ${configured.url.origin}/${configured.path}/.`);
        }
        path = configured.path ? candidate.path.slice(configured.path.length + 1) : candidate.path;
        // Multi-segment URLs remain project URLs, even with a trailing slash.
        namespace = namespace && !path.includes("/");
      } else {
        path = safePath(entry);
      }
      if (!path || (!namespace && !path.includes("/"))) {
        throw new Error("Include both the namespace and project, for example team/project, or end a namespace with /, for example team/.");
      }
      paths.add(namespace ? `${path}/` : path);
    } catch (error) {
      throw new Error(`Additional repository on line ${index + 1}: ${error.message}`);
    }
  }
  return [...paths];
}

export function customRepositoryMatches(project: CustomProject, paths: string[]): boolean {
  const path = project.path_with_namespace;
  return typeof path === "string" && paths.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}

export function groupCatalogRepositories<T extends CustomProject>(projects: T[], groups: RepositoryGroup[], paths: string[]) {
  const buckets = groupRepositories(projects, groups);
  const seen = new Set(buckets.flatMap(({ projects }) => projects.map((project) => String(project.id))));
  const custom: T[] = [];
  for (const project of projects) {
    const key = String(project.id);
    if (seen.has(key) || repositoryGroupFor(project, groups) || !customRepositoryMatches(project, paths)) continue;
    seen.add(key);
    custom.push(project);
  }
  return [{ group: customRepositoryGroup, projects: custom }, ...buckets];
}

export async function fetchCustomRepositories<T extends CustomProject>(
  request: (endpoint: string) => Promise<unknown>,
  paths: string[],
  pages?: (endpoint: string) => Promise<T[]>,
): Promise<T[]> {
  if (!pages && paths.some((path) => path.endsWith("/"))) {
    throw new Error("Namespace entries require a pagination callback: pass API pages as the third argument to fetchCustomRepositories.");
  }
  const batches = await Promise.all(
    [...new Set(paths)].map(async (path): Promise<T[]> => {
      if (!path.endsWith("/")) return [(await request(`projects/${encodeURIComponent(path)}`)) as T];

      const namespace = path.slice(0, -1);
      let projects: T[];
      try {
        projects = await pages!(`groups/${encodeURIComponent(namespace)}/projects?include_subgroups=true&with_shared=false&order_by=path&sort=asc`);
      } catch (error) {
        if (namespace.includes("/") || error?.status !== 404) throw error;
        const users = (await request(`users?username=${encodeURIComponent(namespace)}`)) as { id: number | string; username: string }[];
        const user = users.find((candidate) => candidate.username.toLowerCase() === namespace.toLowerCase());
        if (!user) throw new Error(`Unknown namespace "${namespace}": no accessible group or matching user was found.`);
        projects = await pages!(`users/${encodeURIComponent(user.id)}/projects?order_by=path&sort=asc`);
      }
      return projects.filter((project) => customRepositoryMatches(project, [path]));
    }),
  );
  const seen = new Set<string>();
  return batches.flat().filter((project) => {
    const key = String(project.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
