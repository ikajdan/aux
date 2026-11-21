// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Repository } from "../git-repository.js";
import type { OperationResult, StatusState } from "../application-types.js";
import { safePath } from "../gitlab-sync.js";
import { downloadBlob } from "../ui/download-blob.js";
import { createProjectZip } from "../ui/project-zip.js";

interface FileDownloadDependencies {
  getContext(): { repo: Repository; file: string; projectName: string };
  getReleaseForeground(): (() => Promise<void>) | null;
  getSaving(): Promise<void>;
  getStatusVersion(): number;
  resolveEditorDraft(): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  status(message: string, state: StatusState): void;
}

export function createFileDownload(d: FileDownloadDependencies) {
  async function finishDownload(prepare: () => void | Promise<void>, label: string, release: () => Promise<void>): Promise<OperationResult> {
    const progressVersion = d.getStatusVersion();
    await release?.();
    try {
      await prepare();
      if (progressVersion === d.getStatusVersion()) d.status(`${label} complete.`, "ready");
    } catch (error) {
      console.error(error);
      if (progressVersion === d.getStatusVersion()) d.status(`${label} failed: ${error.message || String(error)}`, "error");
    }
    return { statusHandled: true };
  }

  async function downloadFile(path: string) {
    if (!path) return;
    const { repo, file } = d.getContext();
    const release = d.getReleaseForeground();
    const name = path.split("/").pop();
    if (path === file && !(await d.resolveEditorDraft())) return false;
    await d.getSaving();
    const bytes = new Uint8Array(await d.readFile(`${repo.dir}/${path}`));
    return finishDownload(() => downloadBlob(new Blob([bytes]), name), "Download", release);
  }

  async function downloadProject() {
    const { repo, projectName } = d.getContext();
    const release = d.getReleaseForeground();
    let name = projectName || "document";
    if (!(await d.resolveEditorDraft())) return false;
    await d.getSaving();
    name = name.replace(/[\/\\\x00-\x1f<>:"|?*]/g, "-").replace(/[. ]+$/g, "");
    if (!name || name === "." || name === ".." || name.toLowerCase() === ".git") name = "document";
    safePath(name);
    const entries = Object.create(null);
    entries[`${name}/`] = new Uint8Array();
    const [paths, directories] = await Promise.all([repo.files(), repo.directories()]);
    for (const path of directories) entries[`${name}/${safePath(path)}/`] = new Uint8Array();
    for (const path of paths) entries[`${name}/${safePath(path)}`] = new Uint8Array(await repo.p.readFile(`${repo.dir}/${path}`));
    return finishDownload(async () => {
      const bytes = await createProjectZip(entries);
      downloadBlob(new Blob([bytes], { type: "application/zip" }), `${name}.zip`);
    }, "Download project", release);
  }

  return { downloadFile, downloadProject };
}
