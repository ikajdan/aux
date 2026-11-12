// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { GitLabAPI } from "./gitlab-sync.js";
import type { SnapshotLimits } from "./server-config.js";
export interface GitLink {
  path: string;
  oid: string;
  project?: string;
}
export interface SnapshotFile {
  path: string;
  bytes: Uint8Array;
  mode: string;
}
export interface SnapshotProgress {
  phase: "listing" | "downloading";
  files: number;
  repository: string;
}
export interface MaterializedSnapshot {
  files: SnapshotFile[];
  links: GitLink[];
}
export interface GitLabTreeEntry {
  id: string;
  path: string;
  type: string;
  mode: string;
}
interface ModuleSection {
  path?: string;
  url?: string;
  branch?: string;
}

import { safePath, decode64 } from "./gitlab-sync.js";
let gitlabUrl: string;
export function configureGitLab(url: string) {
  gitlabUrl = url.replace(/\/$/, "");
}
export function resolveModule(parent: string, value: string) {
  if (!gitlabUrl) throw new Error("GitLab URL has not been configured.");
  let url;
  if (value.startsWith("./") || value.startsWith("../")) url = new URL(value, `${gitlabUrl}/${parent}/`);
  else {
    value = value.replace(/^git@([^:]+):/, "https://$1/").replace(/^ssh:\/\/git@/, "https://");
    url = new URL(value);
  }
  const instance = new URL(gitlabUrl);
  const prefix = instance.pathname.replace(/\/$/, "") + "/";
  if (url.origin !== instance.origin || !url.pathname.startsWith(prefix) || url.username || url.password || url.search || url.hash)
    throw new Error("Submodule URL must use the configured GitLab instance");
  const path = decodeURIComponent(url.pathname.slice(prefix.length)).replace(/\.git$/, "");
  safePath(path);
  if (path.split("/").length < 2) throw new Error("Invalid submodule project path");
  return path;
}
export function parseModules(text: string): Map<string, string> {
  const modules: ModuleSection[] = [];
  let section: ModuleSection;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (/^\[submodule\s+"[^"\n]+"\]$/.test(line)) {
      section = {};
      modules.push(section);
      continue;
    }
    const match = /^(path|url|branch)\s*=\s*(.*?)\s*$/.exec(line);
    if (!section || !match) throw new Error("Unsupported .gitmodules syntax");
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (section[match[1] as keyof ModuleSection] !== undefined) throw new Error("Duplicate .gitmodules key");
    section[match[1] as keyof ModuleSection] = value;
  }
  const result = new Map<string, string>();
  for (const m of modules) {
    safePath(m.path);
    if (!m.url || result.has(m.path)) throw new Error("Invalid or duplicate submodule mapping");
    result.set(m.path, m.url);
  }
  return result;
}
const DOWNLOAD_CONCURRENCY = 8;

export async function fetchSnapshot(
  api: GitLabAPI,
  project: string | number,
  ref: string,
  namespace: string,
  limits: Pick<SnapshotLimits, "snapshotBytes" | "snapshotFiles" | "snapshotEntries" | "submoduleDepth"> = {
    snapshotBytes: 30 * 1024 * 1024,
    snapshotFiles: 5000,
    snapshotEntries: 10000,
    submoduleDepth: 8,
  },
  onProgress: (progress: SnapshotProgress) => void = () => {},
): Promise<MaterializedSnapshot> {
  const files: SnapshotFile[] = [],
    links: GitLink[] = [];
  let bytes = 0,
    entries = 0,
    downloaded = 0;
  async function visit(id: string | number, sha: string, name: string, prefix: string, ancestors: string[], depth: number): Promise<void> {
    if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error("Invalid pinned commit");
    if (depth > limits.submoduleDepth) throw new Error(`Submodule depth exceeds ${limits.submoduleDepth}`);
    const identity = `${name}@${sha}`;
    if (ancestors.includes(identity)) throw new Error("Submodule cycle");
    const endpoint = `projects/${encodeURIComponent(id)}/repository`;
    onProgress({ phase: "listing", files: files.length, repository: name });
    const tree = await api.pages<GitLabTreeEntry>(`${endpoint}/tree?recursive=true&ref=${sha}`);
    entries += tree.length;
    if (entries > limits.snapshotEntries) throw new Error("Snapshot exceeds entry limit");
    const seen = new Set();
    for (const t of tree) {
      safePath(t.path);
      if (seen.has(t.path)) throw new Error("Duplicate tree path");
      seen.add(t.path);
      if (!(
        (t.type === "tree" && t.mode === "040000") ||
        (t.type === "blob" && ["100644", "100755", "120000"].includes(t.mode)) ||
        (t.type === "commit" && t.mode === "160000")
      ))
        throw new Error(`Unsupported tree entry: ${t.path} (type ${t.type}, mode ${t.mode})`);
    }
    const gitlinks = tree.filter((t) => t.mode === "160000");
    for (const link of gitlinks) if (tree.some((t) => t.path.startsWith(link.path + "/"))) throw new Error("Overlapping submodule tree");
    let modules = new Map<string, string>();
    const blobs = tree.filter((t) => t.type === "blob");
    const results: SnapshotFile[] = new Array(blobs.length);
    let next = 0;
    let failure: { error: unknown };
    async function download() {
      while (!failure && next < blobs.length) {
        const index = next++;
        const t = blobs[index];
        try {
          const blob = await api.request<{ content: string }>(`${endpoint}/blobs/${t.id}`);
          if (failure) return;
          const data = decode64(blob.content);
          if (bytes + data.length > limits.snapshotBytes || downloaded >= limits.snapshotFiles) throw new Error("Snapshot exceeds compilation limits");
          if (t.path === ".gitmodules" && gitlinks.length) modules = parseModules(new TextDecoder("utf-8", { fatal: true }).decode(data));
          bytes += data.length;
          results[index] = { path: prefix + t.path, bytes: data, mode: t.mode };
          onProgress({ phase: "downloading", files: ++downloaded, repository: name });
        } catch (error) {
          failure ??= { error };
        }
      }
    }
    // Submodules are visited after this pool drains, sharing the same concurrency bound.
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, blobs.length) }, download));
    if (failure) throw failure.error;
    files.push(...results);
    for (const t of gitlinks) {
      if (!modules.has(t.path)) throw new Error(`Missing .gitmodules mapping: ${t.path}`);
      const child = resolveModule(name, modules.get(t.path));
      links.push({ path: prefix + t.path, oid: t.id, project: child });
      await visit(child, t.id, child, prefix + t.path + "/", [...ancestors, identity], depth + 1);
    }
  }
  await visit(project, ref, namespace, "", [], 0);
  return { files, links };
}
