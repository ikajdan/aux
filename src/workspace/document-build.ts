// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createBuildOperation } from "./build-operation.js";
import { materializeSymlinkFiles } from "./symlink-files.js";
import { validateSnapshotSizes, validateRequestSize } from "./snapshot-limits.js";
import { createFileOperationProgress } from "../ui/file-operation-progress.js";
import { encode64, decode64 } from "../gitlab-sync.js";
import type { SnapshotLimits } from "../server-config.js";
import type { OperationResult, StatusState } from "../application-types.js";

type BuildOperation = ReturnType<typeof createBuildOperation>;

type Report = (message: string, state: StatusState) => void;
export interface BuildRepository {
  dir: string;
  modes: Record<string, string>;
  files(): Promise<string[]>;
}
export interface DocumentBuildDependencies {
  getRepo(): BuildRepository;
  getSaving(): Promise<void>;
  getReleaseForeground(): (() => Promise<void>) | null;
  getBuiltPdf(): Blob | null;
  getSyncBuild(): string | null;
  getStatusVersion(): number;
  getToastBuildOperation(): BuildOperation | null;
  setToastBuildOperation(operation: BuildOperation | null): void;
  getLimits(): SnapshotLimits;
  getLogText(): string;
  saveDocument(): Promise<unknown>;
  status: Report;
  updateLog(text: string): void;
  selectLogs(): void;
  preview(pdf: Blob, build: string | null, signal?: AbortSignal, report?: Report): Promise<boolean>;
  resetPreview(): Promise<void>;
  updatePdfDownload(): void;
  setBuiltPdf(pdf: Blob | null): void;
  setEditorBusy(busy: boolean): void;
  publishingButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  fs: { promises: { readFile(path: string): Promise<Uint8Array> } };
}

export function createDocumentBuild(d: DocumentBuildDependencies) {
  let activePdfBuilds = 0;
  const buildingRepositories = new Set<string>();
  let latestPdfBuild: ReturnType<typeof createBuildOperation> | null = null;
  async function buildDocument(): Promise<OperationResult> {
    if (isBuilding(d.getRepo())) return { statusHandled: true };
    const activeRepo = d.getRepo();
    const release = d.getReleaseForeground();
    const operation = createBuildOperation();
    latestPdfBuild = operation;
    buildingRepositories.add(activeRepo.dir);
    const current = () => activeRepo === d.getRepo() && latestPdfBuild === operation;
    let progressVersion: number;
    const report = (message: string, state: StatusState) => {
      if (!current() || (progressVersion !== undefined && progressVersion !== d.getStatusVersion())) return;
      d.status(message, state);
      progressVersion = d.getStatusVersion();
    };
    const previous = { pdf: d.getBuiltPdf(), synctex: d.getSyncBuild() };
    let rendering = false;
    activePdfBuilds++;
    d.setToastBuildOperation(operation);
    d.publishingButton.disabled = true;
    d.cancelButton.onclick = () => {
      void operation.cancel().catch(() => {});
      if (current()) {
        d.status("Canceling build…", "busy");
        progressVersion = d.getStatusVersion();
      }
    };
    report("Preparing document…", "busy");
    try {
      await compileDocument(
        operation,
        () => {
          rendering = true;
        },
        release,
        current,
        report,
      );
      report("Build complete.", "ready");
      return { statusHandled: true };
    } catch (error) {
      if (!current()) return { statusHandled: true };
      if (!operation.signal.aborted) {
        const detail = error.name === "TimeoutError" ? "Request timed out. Check the connection and try again." : error.message || String(error);
        if (!d.getLogText()) d.updateLog(detail);
        if (!d.getBuiltPdf()) d.selectLogs();
        report(`Build failed: ${detail}`, "error");
        return { statusHandled: true };
      }
      try {
        await operation.cancel();
      } catch {
        report("Build canceled locally. Server cancellation could not be confirmed.", "error");
        return { statusHandled: true };
      }
      if (rendering && current()) {
        if (previous.pdf) await d.preview(previous.pdf, previous.synctex);
        else await d.resetPreview();
        if (current()) d.setBuiltPdf(previous.pdf);
      }
      report("Build canceled.", "ready");
      return { statusHandled: true };
    } finally {
      if (d.getToastBuildOperation() === operation) {
        d.setToastBuildOperation(null);
        d.cancelButton.hidden = true;
        d.cancelButton.onclick = null;
      }
      buildingRepositories.delete(activeRepo.dir);
      d.publishingButton.disabled = --activePdfBuilds > 0;
      d.updatePdfDownload();
    }
  }
  async function compileDocument(
    operation: ReturnType<typeof createBuildOperation>,
    onPreviewCommit: () => void,
    onSnapshot?: () => Promise<void>,
    current: () => boolean = () => true,
    report: (message: string, state: StatusState) => void = d.status,
  ): Promise<void | false> {
    const signal = operation.signal;
    await d.saveDocument();
    signal.throwIfAborted();
    const activeRepo = d.getRepo();
    await d.getSaving();
    signal.throwIfAborted();
    if (activeRepo !== d.getRepo()) return;
    const progress = createFileOperationProgress((message) => {
      if (current()) report(message, "busy");
    });
    progress({ phase: "preparing" });
    const paths = await activeRepo.files();
    signal.throwIfAborted();
    progress({ phase: "preparing", completed: 0, total: paths.length });
    const snapshot = [];
    const sizes = [];
    for (const path of paths) {
      const bytes = await d.fs.promises.readFile(`${activeRepo.dir}/${path}`);
      signal.throwIfAborted();
      sizes.push(bytes.byteLength);
      validateSnapshotSizes(sizes, d.getLimits());
      snapshot.push({ path, bytes, mode: activeRepo.modes[path] || "100644" });
      progress({ phase: "preparing", completed: snapshot.length, total: paths.length });
    }
    const files = materializeSymlinkFiles(snapshot, d.getLimits()).map(({ path, bytes }) => ({ path, content: encode64(bytes) }));
    const body = JSON.stringify({ files, buildId: operation.id });
    validateRequestSize(body, d.getLimits());
    signal.throwIfAborted();
    if (onSnapshot) await onSnapshot();
    else d.setEditorBusy(false);
    signal.throwIfAborted();
    if (activeRepo !== d.getRepo() || !current()) return;
    progress({ phase: "compiling" });
    const response = await operation.request(body);
    const result = await response.json();
    signal.throwIfAborted();
    if (activeRepo !== d.getRepo() || !current()) return;
    d.updateLog(result.log || result.error);
    if (!response.ok) {
      if (!d.getBuiltPdf()) d.selectLogs();
      throw new Error(result.error || "Compilation failed. See log.");
    }
    progress({ phase: "rendering" });
    const pdf = new Blob([decode64(result.pdf) as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
    const committed = await d.preview(pdf, result.synctex || null, signal, report);
    if (!committed || activeRepo !== d.getRepo() || !current()) return;
    onPreviewCommit();
    signal.throwIfAborted();
    d.setBuiltPdf(pdf);
    d.updatePdfDownload();
  }
  function isBuilding(repository: Pick<BuildRepository, "dir"> | null | undefined): boolean {
    return buildingRepositories.has(repository?.dir);
  }
  return { buildDocument, compileDocument, isBuilding };
}
