// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ApplicationWorkspace, WorkspaceWarning, Operation, OperationOptions, StatusState } from "../application-types.js";
import type { Repository } from "../git-repository.js";
import type { createEditor } from "../latex-editor.js";
import { restoreFocus } from "../modal-dialogs.js";
import { $ } from "./application-elements.js";
import { operationProgress } from "./operation-progress.js";

export interface OperationRunnerDependencies {
  getSaving: () => Promise<unknown>;
  getWorkspace: () => { repo: Repository | undefined; meta: ApplicationWorkspace | undefined };
  workspaceWarnings: Map<string, WorkspaceWarning>;
  warningState: (meta: ApplicationWorkspace) => WorkspaceWarning;
  refreshWarning: (meta: ApplicationWorkspace, repo: Repository) => Promise<unknown>;
  editor: Pick<ReturnType<typeof createEditor>, "setBusy" | "hasFocus">;
  branchSelect: { close(): void; sync(): void };
  targetBranchSelect: { close(): void; sync(): void };
  status: (message: string, state: StatusState) => void;
  dismissStatus: () => void;
  closeTreeMenu: (restore: boolean) => void;
  syncTree: () => void;
  updateMergeRequestControls: () => void;
  updatePdfDownload: () => void;
  updateFilenameSaveState: () => void;
  processNavigation: () => Promise<unknown>;
  fs: { promises: { flush(): Promise<unknown> } };
}

export function createOperationRunner({
  getSaving, getWorkspace, workspaceWarnings, warningState, refreshWarning,
  editor, branchSelect, targetBranchSelect, status, dismissStatus, closeTreeMenu,
  syncTree, updateMergeRequestControls, updatePdfDownload, updateFilenameSaveState,
  processNavigation, fs,
}: OperationRunnerDependencies) {
  let busy = false;
  let controlsShown = false;
  let releaseForeground: (() => Promise<void>) | null = null;
  const backgroundActions = new Set<string>();
  async function runBackground(action: Operation, label: string, key: string) {
    if (backgroundActions.has(key)) return;
    backgroundActions.add(key);
    try {
      await action();
    } catch (e) {
      console.error(e);
      const detail = e.name === "TimeoutError" ? "Request timed out. Check the connection and try again." : e.message || String(e);
      status(`${label} failed: ${detail}`, "error");
    } finally {
      backgroundActions.delete(key);
    }
  }
  async function run(
    action: Operation,
    label = "Operation",
    quiet = false,
    catalogRefresh = false,
    { initialProgress = true, completion = true, allowSaveFailure = false, transient = false }: OperationOptions = {},
  ) {
    if (busy) return;
    closeTreeMenu(true);
    branchSelect.close();
    targetBranchSelect.close();
    const previousFocus = document.activeElement;
    busy = true;
    controlsShown = !transient;

    editor.setBusy(true, transient);
    if (!quiet && initialProgress) status(`${operationProgress(label)}…`, "busy");
    $("workspace").setAttribute("aria-busy", "true");
    const controls = [
      ...document.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>(
        "button:not([role='tab']):not(.theme-choice):not(#app-menu):not(#shortcuts):not(#connection-close):not(#publishing):not(#publishing-close):not(#cancel-build), select, input:not(#uploads):not(#folder-uploads):not(#workspace-search)",
      ),
    ].filter(
      (control) =>
        !control.closest(".app-dialog, .pdf-controls") &&
        !(
          catalogRefresh &&
          (control.id === "project-search" ||
            control.id === "project-clear-filters" ||
            control.hasAttribute("data-project-sort") ||
            control.classList.contains("project-topic-filter"))
        ),
    );
    let disabled: boolean[];
    const lockControls = () => {
      controlsShown = true;
      disabled = controls.map((c) => c.disabled);
      controls.forEach((c) => (c.disabled = true));
      editor.setBusy(true);
      updatePdfDownload();
      branchSelect.sync();
      targetBranchSelect.sync();
    };
    let busyTimer: ReturnType<typeof setTimeout>;
    if (transient) busyTimer = setTimeout(lockControls, 200);
    else lockControls();
    let released = false;
    const finish = async () => {
      if (released) return;
      const { meta, repo } = getWorkspace();
      if (meta && repo) await refreshWarning(meta, repo);
      released = true;
      if (releaseForeground === release) releaseForeground = null;
      clearTimeout(busyTimer);
      if (disabled) controls.forEach((c, i) => (c.disabled = disabled[i]));
      branchSelect.sync();
      busy = false;
      controlsShown = false;
      updateMergeRequestControls();
      updatePdfDownload();
      syncTree();
      $("workspace").setAttribute("aria-busy", "false");
      editor.setBusy(false);
      updateFilenameSaveState();
      const searchPanel = $("project-search-panel");
      if (!editor.hasFocus() && (!searchPanel || !searchPanel.contains(document.activeElement))) restoreFocus(previousFocus);
      void processNavigation();
    };
    const flushWorkspace = async () => {
      const { meta, repo } = getWorkspace();
      if (!repo) return;
      try {
        await fs.promises.flush();
        for (const state of workspaceWarnings.values()) state.errors.delete("[workspace storage]");
      } catch (error) {
        if (meta) warningState(meta).errors.add("[workspace storage]");
        throw error;
      }
    };
    // Snapshot-based operations can release their foreground lock before finishing.
    // Their eventual completion must not clean up a newer operation's controls or focus.
    const release = async () => {
      await flushWorkspace();
      await finish();
    };
    releaseForeground = release;
    try {
      if (allowSaveFailure) await getSaving().catch(() => {});
      else await getSaving();
      const result = await action();
      if (!released) await flushWorkspace();
      if (!released && !quiet && !(result && typeof result === "object" && result.statusHandled)) {
        if (result === false || !completion) dismissStatus();
        else status(`${label} complete.`, "ready");
      }
    } catch (e) {
      console.error(e);
      const detail = e.name === "TimeoutError" ? "Request timed out. Check the connection and try again." : e.message || String(e);
      status(`${label} failed: ${detail}`, "error");
    } finally {
      await finish();
    }
  }
  return {
    run,
    runBackground,
    get busy() { return busy; },
    get controlsShown() { return controlsShown; },
    get releaseForeground() { return releaseForeground; },
  };
}
