// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface SnapshotEntry {
  oid: string;
  bytes: Uint8Array;
  mode: string;
}
export type RepositorySnapshot = Record<string, SnapshotEntry>;
export type CommitAction =
  | { action: "delete"; file_path: string }
  | { action: "create" | "update"; file_path: string; content: string; encoding: "base64" }
  | { action: "chmod"; file_path: string; execute_filemode: boolean };
export interface GitLabError extends Error {
  status?: number;
}
export interface GitLabAPI {
  request<T = unknown>(endpoint: string, body?: unknown): Promise<T>;
  pages<T = unknown>(endpoint: string): Promise<T[]>;
}

export function safePath(path: string) {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
  )
    throw new Error(`Unsafe path: ${path}`);
  return path;
}
export function encode64(bytes: Uint8Array) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export function decode64(text: string) {
  return Uint8Array.from(atob(text.replace(/\s/g, "")), (c) => c.charCodeAt(0));
}
export function makeAPI(token: () => string, fetcher: typeof fetch = fetch, observe: (status: number) => void = () => {}): GitLabAPI {
  async function request<T = unknown>(endpoint: string, body?: unknown): Promise<T> {
    const requestToken = token();
    const notify = (status: number) => {
      if (requestToken !== token()) return;
      try {
        observe(status);
      } catch {
        /* Observation is best-effort. */
      }
    };
    let response: Response;
    try {
      response = await fetcher(`/api/${endpoint}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "PRIVATE-TOKEN": requestToken, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
        cache: "no-store",
      });
    } catch (error) {
      notify(0);
      throw error;
    }
    notify(response.status);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error(`GitLab relay returned a non-JSON response (HTTP ${response.status}). Check the server/proxy logs.`);
    }
    if (!response.ok) {
      const details = data as { message?: unknown; error?: unknown };
      const error: GitLabError = new Error(`GitLab ${response.status}: ${JSON.stringify(details?.message || details?.error || data)}`);
      error.status = response.status;
      throw error;
    }
    return data as T;
  }
  async function pages<T = unknown>(endpoint: string): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; ; page++) {
      const items = await request<T[]>(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      result.push(...items);
      if (items.length < 100) return result;
    }
  }
  return { request, pages };
}
export function changedActions(base: RepositorySnapshot, current: RepositorySnapshot): CommitAction[] {
  const actions: CommitAction[] = [];
  for (const path of new Set([...Object.keys(base), ...Object.keys(current)])) {
    const before = base[path],
      after = current[path];
    if (before?.oid === after?.oid && before?.mode === after?.mode) continue;
    if (after && !["100644", "100755"].includes(after.mode)) throw new Error(`Cannot push unsupported mode ${after.mode}: ${path}`);
    if (!after) actions.push({ action: "delete", file_path: path });
    else {
      actions.push({ action: before ? "update" : "create", file_path: path, content: encode64(after.bytes), encoding: "base64" });
      if (before?.mode !== after.mode && (after.mode === "100755" || before?.mode === "100755"))
        actions.push({ action: "chmod", file_path: path, execute_filemode: after.mode === "100755" });
    }
  }
  return actions;
}
