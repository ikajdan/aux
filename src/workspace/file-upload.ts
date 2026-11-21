// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Repository } from "../git-repository.js";
import { safePath } from "../gitlab-sync.js";
import type { UploadConflictResult } from "../modal-dialogs.js";
import { serverConfig, type SnapshotLimits } from "../server-config.js";
import { validateSnapshotSizes } from "./snapshot-limits.js";
import { uniqueUploadPath } from "./upload-conflicts.js";

export interface FileUploadDependencies {
  ready(): boolean;
  getRepo(): Pick<Repository, "dir" | "p" | "files" | "assertWritable" | "write"> | null;
  getFile(): string | null;
  resolveEditorDraft(): Promise<boolean>;
  markWorkspace(): void;
  refresh(): Promise<void>;
  openFile(path: string): Promise<void | boolean>;
  getSelection(): string | null;
  setSelection(path: string | null): void;
  expandTreePath(path: string): void;
  syncTree(): void;
  uploadConflictDialog(path: string): Promise<UploadConflictResult | null>;
  getLimits?(): Pick<SnapshotLimits, "snapshotBytes" | "snapshotFiles">;
}

export function createFileUpload(deps: FileUploadDependencies) {
  return async function uploadFiles(files: File[], destination: string, relativePath: (source: File) => string = (source) => source.name) {
    const repo = deps.getRepo();
    if (!deps.ready() || !repo) throw new Error("Open a workspace before uploading files.");
    if (destination) repo.assertWritable(destination);
    const staged = files.map((source) => {
      const name = safePath(relativePath(source));
      const path = safePath(destination ? `${destination}/${name}` : name);
      repo.assertWritable(path);
      return { source, path };
    });
    const sizes = new Map<string, number>();
    for (const path of await repo.files()) sizes.set(path, (await repo.p.stat(`${repo.dir}/${path}`)).size);
    const reserved = new Set<string>();
    for (const { path } of staged) {
      const parts = path.split("/");
      while (parts.length) {
        reserved.add(parts.join("/"));
        parts.pop();
      }
    }
    const planned: typeof staged = [];
    let remainingAction: UploadConflictResult["action"];
    const exists = async (path: string) => {
      if (reserved.has(path) || sizes.has(path)) return true;
      try {
        await repo.p.stat(`${repo.dir}/${path}`);
        return true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return false;
      }
    };
    for (const item of staged) {
      let path = item.path;
      let conflict = sizes.has(path);
      try {
        const stat = await repo.p.stat(`${repo.dir}/${path}`);
        if (stat.isDirectory()) throw new Error(`A folder already exists at ${path}.`);
        conflict = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (conflict) {
        const choice = remainingAction ? { action: remainingAction, applyToRemaining: true } : await deps.uploadConflictDialog(path);
        if (!choice) return false;
        if (choice.applyToRemaining) remainingAction = choice.action;
        if (choice.action === "skip") continue;
        if (choice.action === "keep-both") path = await uniqueUploadPath(path, exists);
      }
      repo.assertWritable(path);
      reserved.add(path);
      sizes.set(path, item.source.size);
      planned.push({ source: item.source, path });
    }
    const plannedPaths = new Set(planned.map(({ path }) => path));
    for (const { path } of planned) {
      const parents = path.split("/");
      parents.pop();
      while (parents.length) {
        const parent = parents.join("/");
        if (plannedPaths.has(parent)) throw new Error(`Cannot upload both a file and a folder at ${parent}.`);
        parents.pop();
      }
    }
    validateSnapshotSizes(sizes.values(), (deps.getLimits ?? (() => serverConfig.limits))());
    if (planned.some((item) => item.path === deps.getFile()) && !(await deps.resolveEditorDraft())) return false;
    let uploaded = false;
    let replacedOpenFile = false;
    try {
      for (const { source, path } of planned) {
        const bytes = new Uint8Array(await source.arrayBuffer());
        deps.markWorkspace();
        await repo.write(path, bytes);
        uploaded = true;
        replacedOpenFile ||= path === deps.getFile();
      }
    } finally {
      if (uploaded) {
        const selection = deps.getSelection();
        await deps.refresh();
        if (replacedOpenFile) await deps.openFile(deps.getFile());
        deps.setSelection(selection);
        if (destination) deps.expandTreePath(destination);
        deps.syncTree();
      }
    }
    return uploaded;
  };
}
