// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ActiveDocument, ApplicationProject, ApplicationWorkspace, NavigationState, Operation, OperationOptions, OperationResult } from "../application-types.js";

export interface NavigationContext {
  busy: boolean;
  project: ApplicationProject;
  meta: ApplicationWorkspace;
  file: string;
  workspaceReady: boolean;
  repo: { files(): Promise<string[]> };
}

export interface NavigationDependencies {
  getContext(): NavigationContext;
  getWorkspaces(): Record<string, ApplicationWorkspace>;
  getCatalog(): ApplicationProject[];
  setProject(project: ApplicationProject): void;
  clearTreeProject(): void;
  setSidebarBranches(branches: string[]): void;
  selectFilesTab(): void;
  isEditorVisible(): boolean;
  showView(editor: boolean, options?: { navigation?: boolean; focus?: boolean }): void;
  activate(workspace: ApplicationWorkspace, options: { build?: boolean; focus?: boolean }): Promise<OperationResult>;
  openFile(path: string): Promise<unknown>;
  confirmWorkspaceLeave(): Promise<boolean>;
  run(action: Operation, label: string, quiet: boolean, catalogRefresh: boolean, options: OperationOptions): Promise<unknown>;
  stat(path: string): Promise<unknown>;
  randomId(): string;
  history: Pick<History, "state" | "replaceState" | "pushState" | "go" | "back">;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  events: Pick<Window, "addEventListener">;
}

export function validNavigation(value: unknown): value is NavigationState {
  const candidate = value as Partial<NavigationState>;
  return Boolean(candidate && typeof candidate.session === "string" && Number.isSafeInteger(candidate.index) && candidate.index >= 0 && ["documents", "editor"].includes(candidate.view));
}

export function validDocument(value: unknown): value is ActiveDocument {
  const candidate = value as Partial<ActiveDocument>;
  return Boolean(candidate && ["string", "number"].includes(typeof candidate.projectId) && String(candidate.projectId).length > 0 && typeof candidate.branch === "string" && candidate.branch.length > 0 && (candidate.filePath == null || typeof candidate.filePath === "string"));
}

/** Construct at the former navigation block: history initialization is intentionally synchronous. */
export function createNavigationController(deps: NavigationDependencies) {
  const { history, storage } = deps;
  const initialNavigation = validNavigation(history.state?.auxView) ? history.state.auxView : null;
  let savedDocument: ActiveDocument = null;
  try {
    const value = JSON.parse(storage.getItem("aux-active-document") || "null");
    if (validDocument(value)) savedDocument = value;
  } catch (error) {
    console.warn("Could not read active document", error);
  }
  const historyDocument = initialNavigation?.view === "editor" ? { ...initialNavigation, projectId: initialNavigation.projectId ?? initialNavigation.project?.id } : null;
  const startupDocument = validDocument(historyDocument) ? historyDocument : initialNavigation?.view === "documents" ? null : savedDocument;
  const historySession = initialNavigation?.session || deps.randomId();
  let currentNavigation: NavigationState = initialNavigation || { session: historySession, index: 0, view: "documents" };
  let restoringDocument = false;
  let pendingNavigation: NavigationState = null;
  let handlingNavigation = false;
  if (!initialNavigation) history.replaceState({ ...history.state, auxView: currentNavigation }, "");

  function persistActiveDocument(editor = deps.isEditorVisible()) {
    if (restoringDocument) return;
    const { project, meta, file } = deps.getContext();
    const location = editor && project && meta ? { projectId: project.id, branch: meta.branch, filePath: file } : null;
    try {
      if (location) storage.setItem("aux-active-document", JSON.stringify(location));
      else storage.removeItem("aux-active-document");
    } catch (error) {
      console.warn("Could not save active document", error);
    }
    if (location && currentNavigation.view === "editor" && !handlingNavigation && !pendingNavigation) recordNavigation(true);
  }

  function recordNavigation(editor: boolean) {
    if (handlingNavigation || pendingNavigation) return;
    const { project, meta, file } = deps.getContext();
    const next: NavigationState = editor
      ? { session: historySession, index: currentNavigation.index, view: "editor", project, projectId: project.id, branch: meta.branch, dir: meta.dir, filePath: file }
      : { session: historySession, index: currentNavigation.index, view: "documents" };
    const push = editor && currentNavigation.view === "documents";
    if (push) next.index++;
    history[push ? "pushState" : "replaceState"]({ ...history.state, auxView: next }, "");
    currentNavigation = next;
  }

  deps.events.addEventListener("popstate", (event) => {
    const next = event.state?.auxView;
    if (next?.session !== historySession) return;
    pendingNavigation = next;
    void processNavigation();
  });

  async function processNavigation() {
    if (deps.getContext().busy || handlingNavigation || !pendingNavigation) return;
    const next = pendingNavigation;
    pendingNavigation = null;
    if (next.index === currentNavigation.index) return;
    handlingNavigation = true;
    await deps.run(async () => {
      try {
        if (!(await deps.confirmWorkspaceLeave())) {
          const actual = history.state?.auxView;
          if (actual?.session === historySession && actual.index !== currentNavigation.index) history.go(currentNavigation.index - actual.index);
          pendingNavigation = null;
          return false;
        }
        if (next.view === "editor") {
          const cached = Object.values(deps.getWorkspaces()).find((m) => String(m.project) === String(next.project?.id) && m.branch === next.branch && m.dir === next.dir);
          const { workspaceReady, project, meta } = deps.getContext();
          if (cached && workspaceReady && String(project?.id) === String(cached.project) && meta?.dir === cached.dir && meta?.branch === cached.branch) {
            deps.showView(true);
          } else if (cached) {
            deps.clearTreeProject();
            deps.setProject(next.project);
            deps.setSidebarBranches(Object.values(deps.getWorkspaces()).filter((m) => String(m.project) === String(next.project.id)).map((m) => m.branch));
            await deps.activate(cached, { build: false });
          } else {
            deps.showView(false);
            next.view = "documents";
            history.replaceState({ ...history.state, auxView: next }, "");
          }
        } else {
          deps.showView(false);
        }
        currentNavigation = next;
        persistActiveDocument(next.view === "editor");
      } catch (error) {
        const actual = history.state?.auxView;
        if (actual?.session === historySession && actual.index !== currentNavigation.index) history.go(currentNavigation.index - actual.index);
        throw error;
      }
    }, "Navigation", true, false, { allowSaveFailure: true });
    handlingNavigation = false;
    void processNavigation();
  }

  function goDocuments() {
    if (deps.getContext().busy) return;
    if (currentNavigation.view === "editor") history.back();
  }

  async function restoreActiveDocument() {
    const m = startupDocument && Object.values(deps.getWorkspaces()).find((entry) => String(entry.project) === String(startupDocument.projectId) && entry.branch === startupDocument.branch && (!initialNavigation?.dir || entry.dir === initialNavigation.dir));
    const cachedProject = m && [initialNavigation?.project, ...deps.getCatalog()].find((entry) => entry && String(entry.id) === String(m.project) && typeof entry.path_with_namespace === "string");
    let available = false;
    if (m && cachedProject) {
      try {
        await deps.stat(`${m.dir}/.git`);
        available = true;
      } catch {
        // A metadata entry alone is not a cached repository.
      }
    }
    if (!available) {
      deps.showView(false, { focus: false });
      return;
    }
    restoringDocument = true;
    try {
      deps.clearTreeProject();
      deps.setProject(cachedProject);
      deps.setSidebarBranches([...new Set(Object.values(deps.getWorkspaces()).filter((entry) => String(entry.project) === String(cachedProject.id)).map((entry) => entry.branch))]);
      deps.selectFilesTab();
      const result = await deps.activate(m, { focus: false });
      const { file, repo } = deps.getContext();
      if (startupDocument.filePath && startupDocument.filePath !== file && (await repo.files()).includes(startupDocument.filePath)) {
        await deps.openFile(startupDocument.filePath);
      }
      return result;
    } catch (error) {
      console.warn("Could not restore cached document", error);
      deps.showView(false, { focus: false });
    } finally {
      restoringDocument = false;
      persistActiveDocument();
    }
  }

  return { recordNavigation, persistActiveDocument, processNavigation, goDocuments, restoreActiveDocument, get restoring() { return restoringDocument; } };
}
