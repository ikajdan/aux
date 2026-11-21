// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { safePath } from "../gitlab-sync.js";
import type { Preview, SourcePosition } from "../pdf-preview.js";
import type { Operation, StatusState } from "../application-types.js";

export interface SourcePdfDependencies {
  editor: {
    getPath(): string;
    getCursor(): { line: number; column: number };
    hasFocus(): boolean;
    goToLine(line: number, column: number): void;
  };
  pdfPreview: Preview;
  syncButton: HTMLButtonElement;
  isBusy(): boolean;
  areBusyControlsShown(): boolean;
  getRepo(): unknown;
  getFile(): string;
  getOpenGeneration(): number;
  run(action: Operation, label: string, blocking: boolean, refresh: boolean, options: { completion: false; transient: true }): Promise<unknown>;
  openFile(path: string): Promise<unknown>;
  expandTreePath(path: string): void;
  status(message: string, state: StatusState): void;
  selectPreview(): void;
}

export function createSourcePdf(d: SourcePdfDependencies) {
  let syncBuild: string = null;
  let syncActive = true;
  let syncTimer: ReturnType<typeof setTimeout>;
  let syncRequest: AbortController;
  let syncSequence = 0;
  let syncError = "";
  let syncGeneration = 0;
  function cancelSync() {
    clearTimeout(syncTimer);
    syncSequence++;
    syncRequest?.abort();
    syncRequest = null;
  }
  function updateSyncControls() {
    const available = Boolean(syncBuild) && !d.areBusyControlsShown();
    d.syncButton.disabled = !available;
    d.syncButton.setAttribute("aria-pressed", String(syncActive));
    d.pdfPreview.setSyncEnabled(available && syncActive);
  }
  function sourceSyncPosition() {
    const path = d.editor.getPath();
    return path && path === d.getFile() && /\.(tex|sty|cls|bib|ltx)$/i.test(path) ? { path, ...d.editor.getCursor() } : null;
  }
  function scheduleForwardSync() {
    if (!syncActive || d.isBusy()) return;
    cancelSync();
    if (!syncBuild || !sourceSyncPosition()) return;
    syncTimer = setTimeout(() => {
      if (d.editor.hasFocus()) void navigateSync("forward", sourceSyncPosition());
    }, 300);
  }
  async function navigateSync(direction: "forward" | "backward", position: SourcePosition | { path: string; line: number; column: number }) {
    if (!syncActive || d.isBusy() || !syncBuild || !position) return;
    cancelSync();
    const sequence = syncSequence;
    const controller = new AbortController();
    syncRequest = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    const build = syncBuild;
    const activeRepo = d.getRepo();
    const generation = syncGeneration;
    const openGeneration = d.getOpenGeneration();
    const current = () => syncActive && sequence === syncSequence && activeRepo === d.getRepo() && generation === syncGeneration;
    try {
      const response = await fetch("/synctex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ build, direction, ...position }),
        signal: controller.signal,
      });
      const result = await response.json();
      if (d.isBusy() || !current() || openGeneration !== d.getOpenGeneration()) return;
      if (!response.ok) {
        if (response.status === 410) {
          syncBuild = null;
        }
        throw new Error(result.error || "Could not navigate between source and PDF.");
      }
      if (direction === "forward") {
        d.selectPreview();
        await new Promise(requestAnimationFrame);
        if (d.isBusy() || !current() || openGeneration !== d.getOpenGeneration()) return;
        if (!d.pdfPreview.goToPosition(result)) throw new Error("Mapped PDF page is unavailable");
      } else {
        if (d.isBusy() || !current() || openGeneration !== d.getOpenGeneration()) return;
        const path = safePath(result.path);
        await d.run(
          async () => {
            if (!current() || openGeneration !== d.getOpenGeneration()) return;
            if (path !== d.getFile() && (await d.openFile(path)) === false) return false;
            if (!current() || d.getFile() !== path) return;
            d.expandTreePath(path);
            d.editor.goToLine(result.line, result.column || 1);
          },
          "Opening source",
          true,
          false,
          { completion: false, transient: true },
        );
      }
    } catch (error) {
      if (
        sequence === syncSequence &&
        activeRepo === d.getRepo() &&
        generation === syncGeneration &&
        error.name !== "AbortError" &&
        syncError !== error.message
      ) {
        syncError = error.message;
        d.status(error.message, "error");
      }
    } finally {
      clearTimeout(timeout);
      if (sequence === syncSequence) {
        syncRequest = null;
        updateSyncControls();
      }
    }
  }
  async function preview(blob: Blob, build: string = null, signal?: AbortSignal, report?: (message: string, state: StatusState) => void) {
    signal?.throwIfAborted();
    cancelSync();
    syncError = "";
    const generation = ++syncGeneration;
    const previousSyncBuild = syncBuild;
    syncBuild = null;
    updateSyncControls();
    d.selectPreview();
    const abort = () => {
      if (generation !== syncGeneration) return;
      syncGeneration++;
      cancelSync();
      syncBuild = previousSyncBuild;
      updateSyncControls();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await d.pdfPreview.show(blob, signal, report);
      signal?.throwIfAborted();
      if (generation !== syncGeneration) return false;
      syncBuild = build;
      updateSyncControls();
      return true;
    } catch (error) {
      if (generation === syncGeneration) {
        syncBuild = previousSyncBuild;
        updateSyncControls();
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  function reset() {
    cancelSync();
    syncActive = true;
    syncError = "";
    syncBuild = null;
    syncGeneration++;
  }
  function installUI() {
    d.syncButton.onclick = () => {
      if (d.isBusy() || !syncBuild) return;
      cancelSync();
      syncActive = !syncActive;
      syncError = "";
      updateSyncControls();
      if (syncActive) void navigateSync("forward", sourceSyncPosition());
    };
  }
  return {
    cancelSync,
    updateSyncControls,
    scheduleForwardSync,
    navigateSync,
    preview,
    reset,
    installUI,
    get build() {
      return syncBuild;
    },
  };
}
