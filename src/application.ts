// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createSettingsController } from "./ui/settings.js";
import { createCatalogController } from "./projects/catalog.js";
import { createSourcePdf } from "./workspace/source-pdf.js";
import { createThemeController } from "./ui/theme.js";
import { Buffer } from "buffer";
import { randomId } from "./random-id.js";
import type { createBuildOperation } from "./workspace/build-operation.js";
import { createDocumentBuild } from "./workspace/document-build.js";
import { createFileUpload } from "./workspace/file-upload.js";
import { installFileUploadUI } from "./workspace/file-upload-ui.js";
import { createStatusController } from "./ui/status.js";
import { serverConfig } from "./server-config.js";
import { createCatalogView } from "./projects/catalog-view.js";
import { repositoryGroupFor } from "./projects/repository-groups.js";
import { customRepositoryMatches } from "./projects/custom-repositories.js";
import { readStorage, loadSettings, loadProjects, loadWorkspaces } from "./browser-storage.js";

import LightningFS from "@isomorphic-git/lightning-fs";
import { Repository } from "./git-repository.js";
import { configureGitLab, fetchSnapshot } from "./gitlab-submodules.js";
import { makeAPI, safePath } from "./gitlab-sync.js";
import { icon, initializeIcons, type IconName } from "./ui-icons.js";
import { createEditor } from "./latex-editor.js";
import { createSelect } from "./select-control.js";
import { createWorkspaceSearch } from "./workspace-search.js";
import { createPreview, type SourcePosition } from "./pdf-preview.js";
import { createImagePreview } from "./image-preview.js";
import { installShortcuts } from "./keyboard-shortcuts.js";
import { confirmDialog, uploadConflictDialog, promptDialog, saveChangesDialog, restoreFocus } from "./modal-dialogs.js";
import { createWorkspaceLayout } from "./workspace/pane-layout.js";
import { renderHistory as renderWorkspaceHistory } from "./workspace/change-history.js";
import { createOperationRunner } from "./ui/operations.js";
import { createFileTree } from "./workspace/file-tree.js";
import { createFileDownload } from "./workspace/file-download.js";
import { createFileOperationProgress } from "./ui/file-operation-progress.js";
import { initializeNewProject } from "./projects/new-project.js";
import { initializeDialogShells } from "./ui/dialog-shell.js";
import { localChangeBranches } from "./workspace/local-changes.js";
import { createEditorDocument } from "./workspace/editor-document.js";
import { createPublishing } from "./workspace/publishing.js";
import { createNavigationController } from "./workspace/navigation.js";

import { $ } from "./ui/application-elements.js";
import type {
  ProjectId,
  RemoteBranch,
  ApplicationProject,
  ApplicationWorkspace,
  WorkspaceWarning,
  OperationOptions,
  Operation,
  StatusState,
  WorkspaceStatusKind,
  WorkspaceIndicator,
} from "./application-types.js";

configureGitLab(serverConfig.gitlabUrl);

for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-gitlab-token-link]")) {
  link.href = `${serverConfig.gitlabUrl}/-/user_settings/personal_access_tokens`;
  link.append(icon("external"));
}

declare const __APP_VERSION__: string;

(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
initializeDialogShells();
initializeIcons();
let toastBuildOperation: ReturnType<typeof createBuildOperation> | null = null;
const statusController = createStatusController({
  content: $("status"),
  toast: $("status-toast"),
  cancelBuild: $("cancel-build"),
  isBusy: () => operations.busy,
  getBuildOperation: () => toastBuildOperation,
});
const { status, dismissStatus } = statusController;
const branchSelect = createSelect($("branches"));
const targetBranchSelect = createSelect($("target-remote-branches"));
function setSidebarBranches(names: string[]) {
  branchSelect.setOptions(names.filter((name) => name !== ":new-branch"));
  const addNew = document.createElement("option");
  addNew.value = ":new-branch";
  addNew.textContent = "New branch…";
  addNew.dataset.separator = "true";
  $("branches").append(addNew);
  branchSelect.rebuild();
}
$("branches").onchange = () => {
  if ($("branches").value !== ":new-branch") return;
  branchSelect.setValue(meta?.branch || "");
  void run(
    async () => {
      if (!project || !meta) throw new Error("Open a project first.");
      const sourceBranch = meta.branch;
      const name = await promptDialog(
        "Enter a name for the new remote branch. It will start at the current workspace's pulled revision. Local changes are not included.",
        {
          title: "New remote branch",
          label: "Branch name",
          inputHint: { text: "This branch will be based on ", code: sourceBranch },
          icon: "branch",
          confirmLabel: "Create branch",
          confirmIcon: "branch",
        },
      );
      if (!name?.trim()) return false;
      if (!(await resolveEditorDraft())) return false;
      status("Creating branch…", "busy");
      await api.request(`projects/${encodeURIComponent(project.id)}/repository/branches`, {
        branch: name.trim(),
        ref: meta.remote,
      });
      await refreshRemoteBranches();
      await switchToPublishedBranch(name.trim());
    },
    "Creating branch",
    false,
    false,
    { initialProgress: false },
  );
};

const theme = createThemeController({
  root: document.documentElement,
  groups: [...document.querySelectorAll<HTMLElement>(".theme-options")],
  savedThemeValue: readStorage("aux-theme"),
  media: matchMedia,
  storage: { setItem: (key, value) => localStorage.setItem(key, value) },
  setupStatus: $("setup-status"),
  reportSettingsError: (message) => settingsStatus(message, "error"),
});
const editor = createEditor($("editor"), updateEditorDraft, scheduleForwardSync);
const imagePreview = createImagePreview($("image-preview"));
function resetImagePreview() {
  documents.resetImagePreview();
}
const pdfPreview = createPreview($("pdf"), $("preview-empty"), status, (position) => {
  void navigateSync("backward", position);
});
theme.connectEditor((value) => editor.setTheme(value));
const fs = new LightningFS("aux-workspaces-v1");
const api = makeAPI(() => $("token").value);
const preferences = createSettingsController({
  initialSettings: loadSettings(),
  theme,
  getCustomRepositories: () => catalogController.customRepositories,
  setCustomRepositories: (values) => catalogController.replaceCustomRepositories(values),
  saveCustomRepositories,
  refreshDocuments,
  renderCatalog,
  updatePageTitle,
  status,
  isBusy: () => operations.busy,
  run,
  validateToken: (candidate) => makeAPI(() => candidate).request<{ id: number }>("user"),
});
const workspaceLayout = createWorkspaceLayout(
  () => preferences.values,
  (next) => {
    preferences.setValues(next);
  },
);

const catalogView = createCatalogView({
  repos: $("repos"),
  creationCard: $("new-project-card"),
  refreshButton: $("repositories"),
  search: $("project-search"),
  topicFilters: $("project-topic-filters"),
  clearFilters: $("project-clear-filters"),
  sortButtons: [...document.querySelectorAll<HTMLElement>("[data-project-sort]")],
  gitlabUrl: serverConfig.gitlabUrl,
  repositoryGroups: serverConfig.repositoryGroups,
  storage: {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
  },
  openProject: (p, source) => run(() => openProject(p), source === "title" ? "Edit" : "Edit Document", false, false, { completion: false }),
  workspaceStatus: projectWorkspaceStatus,
  reviewWorkspace: (id, kind) => run(() => reviewWorkspaceStatus(id, kind), "Opening Publish Changes", true, false, { completion: false }),
  requestRender: renderCatalog,
});
const catalogController = createCatalogController({
  initialProjects: loadProjects(),
  config: serverConfig,
  api,
  view: catalogView,
  elements: {
    refresh: $("repositories"),
    customRepositories: $<HTMLTextAreaElement>("custom-repositories"),
    customRepositoriesStatus: $("custom-repositories-status"),
  },
  getToken: () => $("token").value,
  getSettings: () => preferences.values,
  setSettings: (next) => preferences.setValues(next),
  storage: { setItem: (key, value) => localStorage.setItem(key, value) },
  readStorage,
  status,
  dismissStatus,
  getStatusVersion: () => statusController.version,
});
let workspaces: Record<string, ApplicationWorkspace> = loadWorkspaces();
let project: ApplicationProject;
let repo: Repository;
let meta: ApplicationWorkspace;
let selectedTreePath: string;
let changedPaths = new Set<string>();
let builtPdf: Blob;

function updateFilenameSaveState() {
  documents.updateFilenameSaveState();
}
let workspaceReady = false;
let treeProject: ProjectId;
// Unknown cached repositories are conservatively risky until their first status check.
const workspaceWarnings = new Map<string, WorkspaceWarning>();
const operations = createOperationRunner({
  getSaving: () => documents.saving,
  getWorkspace: () => ({ repo, meta }),
  workspaceWarnings,
  warningState,
  refreshWarning,
  editor,
  branchSelect,
  targetBranchSelect,
  status,
  dismissStatus,
  closeTreeMenu,
  syncTree,
  updateMergeRequestControls: () => publishing.updateMergeRequestControls(),
  updatePdfDownload,
  updateFilenameSaveState,
  processNavigation,
  fs,
});
function warningState(m: ApplicationWorkspace) {
  if (!workspaceWarnings.has(m.dir)) workspaceWarnings.set(m.dir, { dirty: true, unpublished: true, pending: 0, errors: new Set(), version: 0 });
  return workspaceWarnings.get(m.dir);
}
const sourcePdf = createSourcePdf({
  editor,
  pdfPreview,
  syncButton: $("sync-source-pdf"),
  isBusy: () => operations.busy,
  areBusyControlsShown: () => operations.controlsShown,
  getRepo: () => repo,
  getFile: () => documents.path,
  getOpenGeneration: () => documents.openGeneration,
  run,
  openFile,
  expandTreePath,
  status,
  selectPreview: () => selectOutputTab($("preview-tab")),
});
const documents = createEditorDocument({
  editor,
  imagePreview,
  fs,
  getWorkspace: () => ({ repo, meta }),
  workspaceWarnings,
  warningState,
  elements: { editor: $("editor"), filename: $("filename"), readOnly: $("file-read-only"), discard: $("discard-file") },
  isBusy: () => operations.busy,
  areBusyControlsShown: () => operations.controlsShown,
  isWorkspaceReady: () => workspaceReady,
  setSelectedTreePath: (path) => {
    selectedTreePath = path;
  },
  updatePageTitle,
  syncTree,
  updateSyncControls,
  persistActiveDocument,
  treePathWritable,
  preview,
  showWorkspaceStatus,
  updatePublishingSummary,
  refreshSearch: () => workspaceSearch.refresh(),
  markWorkspace,
  refresh,
  confirmDialog,
  saveChangesDialog,
});
function projectWorkspaceStatus(id: ProjectId): WorkspaceIndicator[] {
  const branches = localChangeBranches(id, Object.values(workspaces), workspaceWarnings);
  return branches.length
    ? [
        {
          label: "Local changes",
          branches,
          kind: "changes",
          icon: "sync",
          detail: `Local changes on: ${branches.join(", ")}`,
        },
      ]
    : [];
}
function showWorkspaceStatus(id: ProjectId) {
  catalogView.showWorkspaceStatus(id);
}
async function reviewWorkspaceStatus(id: ProjectId, kind: WorkspaceStatusKind) {
  const p = catalogController.projects.find((p) => String(p.id) === String(id));
  const branches = projectWorkspaceStatus(id).find((indicator) => indicator.kind === kind)?.branches || [];
  const candidates = Object.values(workspaces).filter((m) => String(m.project) === String(id) && branches.includes(m.branch));
  const m = candidates.find((m) => m.dir === meta?.dir) || candidates[0];
  if (!p || !m) throw new Error("No matching cached workspace is available. Refresh the documents list and try again.");
  if (workspaceReady && meta?.dir === m.dir && String(project?.id) === String(id)) {
    await refresh();
    showView(true);
  } else {
    if (!(await confirmWorkspaceLeave())) return false;
    if (String(project?.id) !== String(id)) treeProject = null;
    project = p;
    const local = Object.values(workspaces).filter((m) => String(m.project) === String(id));
    setSidebarBranches(local.map((m) => m.branch));
    await activate(m, { build: false });
  }
  selectSidebarTab($("project-tab"));
  return openPublishing();
}

function markWorkspace(m = meta) {
  if (!m) return;
  const state = warningState(m);
  state.version++;
  state.dirty = true;
  state.dirtyKnown = true;
  showWorkspaceStatus(m.project);
}
async function refreshWarning(m: ApplicationWorkspace, repository = new Repository(fs, m.dir, m.links, m.modes)) {
  const state = warningState(m),
    version = state.version;
  try {
    const changes = await repository.changes();
    const head = await repository.head();
    const unpublishedCount = head === m.base ? 0 : await repository.unpublishedCommitCount(m.base);
    if (version !== state.version || state.pending) return;
    state.dirty = changes.length > 0;
    state.unpublished = head !== m.base;
    state.unpublishedCount = unpublishedCount;
    state.known = true;
    state.dirtyKnown = true;
    if (repository === repo && m.dir === meta?.dir) {
      changedPaths = new Set(changes.map(([path]) => path));
      syncTree();
    }
    return changes;
  } catch (error) {
    // A failed scan is risky for leaving, but is not evidence of local edits.
    if (!state.dirty) state.dirtyKnown = false;
    state.dirty = true;
    console.warn("Could not check workspace status", error);
  } finally {
    showWorkspaceStatus(m.project);
    if (m.dir === meta?.dir) updatePublishingSummary();
  }
}
async function confirmWorkspaceLeave() {
  if (!(await resolveEditorDraft())) return false;
  if ($("workspace").hidden || !meta) return true;
  const state = warningState(meta);
  if (state.pending === 0 && state.errors.size === 0) return true;
  return confirmDialog(
    "Some edits in this workspace are still being saved or could not be written to browser storage. Leaving now may lose those unsaved edits.\n\nSuccessfully saved work remains in this browser.",
    {
      title: "Leave workspace",
      icon: "warning",
      confirmLabel: "Leave anyway",
      cancelLabel: "Stay",
    },
  );
}
window.addEventListener("beforeunload", (event) => {
  if (!documents.dirty && !(operations.busy && repo) && ![...workspaceWarnings.values()].some((state) => state.pending > 0 || state.errors.size > 0)) return;
  event.preventDefault();
  event.returnValue = "";
});

preferences.installUI();
function settingsStatus(text: string, state: StatusState = "ready") {
  preferences.settingsStatus(text, state);
}
function setupComplete() {
  return preferences.setupComplete();
}
let shortcutsFocus: Element;
function openShortcuts() {
  shortcutsFocus = document.activeElement;
  $("shortcuts-dialog").showModal();
  updatePageTitle();
}
$("shortcuts").onclick = openShortcuts;

$("shortcuts-dialog").onclose = () => {
  updatePageTitle();
  restoreFocus(shortcutsFocus);
};
initializeNewProject({
  api,
  config: serverConfig,
  getToken: () => $("token").value,
  onCreated: (created) => {
    if (!repositoryGroupFor(created, serverConfig.repositoryGroups) && !customRepositoryMatches(created, catalogController.customRepositories)) {
      const paths = [...catalogController.customRepositories, created.path_with_namespace];
      const next = { ...preferences.values, customRepositories: paths };
      localStorage.setItem("aux-settings", JSON.stringify(next));
      preferences.setValues(next);
      catalogController.replaceCustomRepositories(paths);
      $<HTMLTextAreaElement>("custom-repositories").value = paths.join("\n");
    }
    catalogController.addProject(created);
    renderCatalog();
  },
  onReady: () => refreshDocuments(),
});
$("about-version").textContent = __APP_VERSION__;
$<HTMLAnchorElement>("about-version").href = `https://github.com/ikajdan/aux/releases/tag/v${encodeURIComponent(__APP_VERSION__)}`;
const publishing = createPublishing({
  api,
  getMeta: () => meta,
  getProject: () => project,
  getRepository: () => repo,
  getFile: () => documents.path,
  getWorkspaces: () => workspaces,
  isBusy: () => operations.busy,
  isWorkspaceReady: () => workspaceReady,
  setMeta: (value) => {
    meta = value;
  },
  setWorkspaces: (value) => {
    workspaces = value;
  },
  persist,
  resolveEditorDraft,
  warningState,
  refreshWarning,
  markWorkspace,
  refresh,
  pull,
  openFile,
  setSidebarBranches,
  branchSelect,
  targetBranchSelect,
  updatePageTitle,
  restorePublishingFocus() {
    if ($("workspace").hidden) $("repositories-heading").focus();
    else if ($("project-panel").hidden) sidebarTabs.find((tab) => tab.getAttribute("aria-selected") === "true").focus();
    else $("publishing").focus();
  },
  status,
  run,
});
const {
  targetBranchCache,
  updateTargetBranches,
  openPublishing,
  switchToPublishedBranch,
  updateCommitControls,
  updatePushControls,

  push,
  publishMergeRequest,
  commit,
} = publishing;
publishing.installUI();
function persist(next = workspaces) {
  localStorage.setItem("aux-workspaces", JSON.stringify(next));
}

function button(text: string, action: Operation, iconName: IconName = "file", quiet = false, options: OperationOptions = {}) {
  const b = document.createElement("button");
  b.append(icon(iconName), document.createTextNode(text));
  b.type = "button";
  b.onclick = () => run(action, text, quiet, false, options);
  return b;
}
function run(action: Operation, label = "Operation", quiet = false, catalogRefresh = false, options: OperationOptions = {}) {
  return operations.run(action, label, quiet, catalogRefresh, options);
}
function runBackground(action: Operation, label: string, key: string) {
  return operations.runBackground(action, label, key);
}
const sidebarTabs = [$("files-tab"), $("search-tab"), $("project-tab")];
const workspaceSearch = createWorkspaceSearch({
  panel: $("project-search-panel"),
  input: $("workspace-search"),
  status: $("workspace-search-status"),
  results: $("workspace-search-results"),
  context: () => (repo && workspaceReady ? { repo, saved: documents.saving, path: editor.getPath(), text: editor.getText() } : null),
  open: async (source, path, match) => {
    if (operations.busy) throw new Error("Wait for the current operation to finish before opening a result.");
    await run(
      async () => {
        if (source !== repo) return;
        if ((await openFile(path, { source: true })) === false) return false;
        if (source === repo && documents.path === path) editor.goToLine(match.line, match.column);
      },
      "Opening search result",
      true,
      false,
      { completion: false, transient: true },
    );
  },
});
function selectSidebarTab(selected: HTMLElement, focus = false) {
  selected.closest<HTMLElement>('[role="tablist"]').dataset.activeIndex = String(sidebarTabs.indexOf(selected));
  for (const tab of sidebarTabs) {
    const active = tab === selected;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    const panel = $(tab.getAttribute("aria-controls"));
    if (!active && (panel?.contains(document.activeElement) || tab === document.activeElement)) focus = true;
    if (panel) panel.hidden = !active;
  }
  if (focus) selected.focus();
}
$("project-branch").onclick = () => selectSidebarTab($("project-tab"), true);
for (const [index, tab] of sidebarTabs.entries()) {
  tab.onclick = () => selectSidebarTab(tab);
  tab.onkeydown = (event) => {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % sidebarTabs.length;
    else if (event.key === "ArrowLeft") next = (index + sidebarTabs.length - 1) % sidebarTabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = sidebarTabs.length - 1;
    else return;
    event.preventDefault();
    selectSidebarTab(sidebarTabs[next], true);
  };
}

function updatePageTitle() {
  const path = document.createElement("bdi");
  path.dir = "ltr";
  path.textContent = documents.path || "No file open";
  $("filename").replaceChildren(path);
  $("filename").title = documents.path || "";
  updateFilenameSaveState();
  const workspaceVisible = !$("workspace").hidden;
  const name = workspaceVisible ? project?.name || (project?.path || project?.path_with_namespace || "").split("/").pop() : "";
  if ($("shortcuts-dialog").open) document.title = `Keyboard shortcuts${name ? ` — ${name}` : ""} · Aux`;
  else if ($("connection-dialog").open) document.title = "Settings · Aux";
  else if ($("publishing-dialog").open) document.title = `Publish Changes${name ? ` — ${name}` : ""} · Aux`;
  else if (name) document.title = `${documents.path ? `${documents.path} — ` : ""}${name}${meta?.branch ? ` (${meta.branch})` : ""} · Aux`;
  else document.title = "Documents · Aux";
}
const navigation = createNavigationController({
  getContext: () => ({ busy: operations.busy, project, meta, file: documents.path, workspaceReady, repo }),
  getWorkspaces: () => workspaces,
  getCatalog: () => catalogController.projects,
  setProject: (value) => {
    project = value;
  },
  clearTreeProject: () => {
    treeProject = null;
  },
  setSidebarBranches,
  selectFilesTab: () => selectSidebarTab($("files-tab")),
  isEditorVisible: () => !$("workspace").hidden,
  showView,
  activate,
  openFile,
  confirmWorkspaceLeave,
  run,
  stat: (path) => fs.promises.stat(path),
  randomId,
  history,
  storage: {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
  },
  events: window,
});
function recordNavigation(editor: boolean) {
  navigation.recordNavigation(editor);
}
function persistActiveDocument(editor?: boolean) {
  navigation.persistActiveDocument(editor);
}
function processNavigation() {
  return navigation.processNavigation();
}
function showView(editor: boolean, { navigation = true, focus = true } = {}) {
  closeTreeMenu();
  branchSelect.close();
  if (navigation) recordNavigation(editor);
  if (navigation || editor) persistActiveDocument(editor);
  document.body.classList.toggle("editor-view", editor);
  $("dashboard").hidden = editor;
  $("workspace").hidden = !editor;
  if (editor) workspaceLayout.showDividerHint();
  updatePageTitle();
  $("title").hidden = !editor;
  $("go-documents").hidden = !editor;
  $("shortcuts").hidden = !editor;
  if (!editor && $("shortcuts-dialog").open) $("shortcuts-dialog").close();
  const projectName = editor ? project.name || (project.path || project.path_with_namespace || "").split("/").pop() : "";
  const projectTopic = document.createElement("span");
  projectTopic.className = "project-link-label";
  projectTopic.textContent = projectName;
  $("project-link").replaceChildren(projectTopic);
  $("project-link").title = `Open ${projectName} in GitLab`;
  $("project-link").setAttribute("aria-label", `Open ${projectName} in GitLab`);
  const branchLabel = document.createElement("span");
  branchLabel.className = "project-branch-label";
  branchLabel.textContent = editor ? meta.branch : "";
  $("project-branch").replaceChildren(icon("branch"), branchLabel);
  $("project-branch").title = "Open Repo tab";
  $("project-branch").setAttribute("aria-label", editor ? `Open Repo tab for branch ${meta.branch}` : "Open Repo tab");

  if (editor) {
    $("project-link").href = `${serverConfig.gitlabUrl}/${project.path_with_namespace.split("/").map(encodeURIComponent).join("/")}`;
  } else {
    $("project-link").removeAttribute("href");
  }
  const target = editor ? sidebarTabs.find((tab) => tab.getAttribute("aria-selected") === "true").id : "repositories-heading";
  if (focus) $(target).focus();
}
catalogController.installUI();
function renderCatalog() {
  catalogController.renderCatalog();
}
const { downloadFile, downloadProject } = createFileDownload({
  getContext: () => ({ repo, file: documents.path, projectName: project?.path }),
  getReleaseForeground: () => operations.releaseForeground,
  getSaving: () => documents.saving,
  getStatusVersion: () => statusController.version,
  resolveEditorDraft,
  readFile: (path) => fs.promises.readFile(path),
  status,
});
function treePathWritable(path: string) {
  if (!repo || !path) return false;
  try {
    repo.assertWritable(path);
    return true;
  } catch {
    return false;
  }
}
let treeClipboard: { dir: string; path: string; type: "copy" | "cut" };
const treeUI = createFileTree(
  $("file-tree"),
  () => ({
    busy: operations.busy,
    workspaceReady,
    repo,
    treeClipboard,
    selectedTreePath,
    file: documents.path,
    changedPaths,
    dirty: documents.dirty,
    treeProject,
    project: meta?.project,
    links: meta?.links,
  }),
  {
    setSelectedPath(path) {
      selectedTreePath = path;
    },
    setTreeProject(project) {
      treeProject = project;
    },
    pathWritable: treePathWritable,
    actionDisabled: fileActionDisabled,
    menuAction(id, label, path, destination) {
      if (id === "download") void run(() => downloadFile(path), "Download");
      else if (id === "copy" || id === "cut") setTreeClipboard(path, id);
      else if (id === "paste") void run(() => pasteTreePath(destination), "Paste");
      else void invokeFileAction(id, label);
    },
    fileButton(name, path, image) {
      return button(name, () => openFile(path), image, true, { transient: true });
    },
    syncActions() {
      for (const id of ["new", "new-folder", "upload", "upload-folder", "download-project"]) {
        $<HTMLButtonElement>(id).disabled = fileActionDisabled(id);
      }
    },
  },
);
function setTreeClipboard(path: string, type: "copy" | "cut") {
  safePath(path);
  if (type === "cut") repo.assertWritable(path);
  treeClipboard = { dir: repo.dir, path, type };
  syncTree();
}
async function pasteTreePath(parent: string) {
  if (!(await resolveEditorDraft())) return false;
  const clipboard = treeClipboard;
  if (!clipboard || clipboard.dir !== repo.dir) return false;
  if (parent) repo.assertWritable(parent);
  if (parent === clipboard.path || parent.startsWith(clipboard.path + "/")) throw new Error("Cannot paste an item into itself.");
  const basename = clipboard.path.split("/").pop();
  const directory = (await repo.p.stat(`${repo.dir}/${clipboard.path}`)).isDirectory();
  const dot = directory ? -1 : basename.lastIndexOf(".");
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  const extension = dot > 0 ? basename.slice(dot) : "";
  let target;
  for (let index = 0; ; index++) {
    const name = index ? `${stem} copy${index > 1 ? " " + index : ""}${extension}` : basename;
    target = parent ? `${parent}/${name}` : name;
    repo.assertWritable(target);
    try {
      await repo.p.stat(`${repo.dir}/${target}`);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  if (clipboard.type === "cut") {
    await applyRename(clipboard.path, target);
    treeClipboard = null;
  } else {
    await repo.copyPath(clipboard.path, target);
    markWorkspace();
    selectedTreePath = target;
    await refresh();
  }
  expandTreePath(target);
  syncTree();
}
function closeTreeMenu(focus = false) {
  treeUI.closeTreeMenu(focus);
}
function syncTree() {
  treeUI.syncTree();
}
function fileActionDisabled(id: string) {
  if (operations.busy || !workspaceReady || !repo) return true;
  if (id === "rename" || id === "delete") return !treePathWritable(selectedTreePath);
  if (id === "download-project") return false;
  const parent = creationDirectory();
  return Boolean(parent && !treePathWritable(parent));
}
function invokeFileAction(id: string, label = id) {
  if (fileActionDisabled(id)) return;
  return run(getFileActions()[id], label);
}
async function renamePath(source: string) {
  repo.assertWritable(source);
  const target = await promptDialog("Enter the new repository-relative path. You can also move this item to another folder.", {
    title: "Rename",
    icon: "rename",
    label: "New path",
    defaultValue: source,
    confirmLabel: "Rename",
  });
  if (target === null || target === source) return false;
  return applyRename(source, target);
}
async function applyRename(source: string, target: string) {
  if (!(await resolveEditorDraft())) return false;
  safePath(target);
  await repo.rename(source, target);
  let persistenceFailed = false;
  try {
    persist();
  } catch (error) {
    console.warn("Could not save renamed file modes", error);
    persistenceFailed = true;
  }
  markWorkspace();
  const movedPath = (path: string) => (path === source || path.startsWith(source + "/") ? target + path.slice(source.length) : path);
  if (treeClipboard?.dir === repo.dir) treeClipboard.path = movedPath(treeClipboard.path);
  for (const details of $("file-tree").querySelectorAll("details")) details.dataset.path = movedPath(details.dataset.path);
  if (selectedTreePath) selectedTreePath = movedPath(selectedTreePath);
  if (documents.path && movedPath(documents.path) !== documents.path) {
    documents.path = movedPath(documents.path);
    editor.setPath(documents.path);
    imagePreview.rename(documents.path);
    updatePageTitle();
  }
  await refresh();
  persistActiveDocument();
  if (persistenceFailed)
    throw new Error(
      "Renamed locally, but could not save file permissions in browser storage. Keep this tab open; do not reload until browser storage is available and workspace metadata can be saved.",
    );
}

function creationDirectory() {
  const selected = selectedTreePath ?? documents.path;
  if (!selected) return "";
  const directory = [...$("file-tree").querySelectorAll<HTMLElement>("summary[data-path]")].some((row) => row.dataset.path === selected);
  return directory ? selected : selected.split("/").slice(0, -1).join("/");
}
async function newPath(folder = false) {
  const parent = creationDirectory();
  const kind = folder ? "folder" : "file";
  const name = await promptDialog(
    `Create a ${kind} in ${parent ? parent + "/" : "the repository root"}.${folder ? " Empty folders are saved locally but not tracked by Git." : ""}`,
    {
      title: folder ? "New folder" : "New file",
      icon: folder ? "new-folder" : "new",
      label: folder ? "Folder name" : "Filename",
      confirmLabel: folder ? "Create folder" : "Create file",
    },
  );
  if (name === null) return null;
  safePath(name);
  if (name !== name.split("/").pop()) throw new Error("Enter a name without slashes or backslashes.");
  const path = parent ? `${parent}/${name}` : name;
  await repo.assertAvailable(path);
  return path;
}
function expandTreePath(path: string) {
  treeUI.expandTreePath(path);
}
function renderTree(paths: string[], directories: string[] = []) {
  treeUI.renderTree(paths, directories);
}
function updatePublishingSummary() {
  if ($("publishing-dialog").open) {
    updateCommitControls();
    updatePushControls();
  }
}
function renderHistory(changes: Awaited<ReturnType<Repository["changes"]>>, logs: Awaited<ReturnType<Repository["history"]>>) {
  updatePublishingSummary();
  renderWorkspaceHistory($("history"), meta, changes, logs);
}
async function refresh() {
  const changes = (await refreshWarning(meta, repo)) ?? (await repo.changes());
  const [paths, directories] = await Promise.all([repo.files(), repo.directories()]);
  if (documents.path && !paths.includes(documents.path)) {
    documents.path = null;
    resetImagePreview();
    loadEditorDocument();
    editor.setReadOnly(true);
    $("filename").textContent = "No file open";
    updatePageTitle();
    persistActiveDocument();
  }
  if (selectedTreePath && !paths.includes(selectedTreePath) && !directories.includes(selectedTreePath)) selectedTreePath = null;
  renderTree(paths, directories);
  workspaceSearch.refresh();
  const logs = await repo.history();
  renderHistory(changes, logs);
}
function updateLog(text: string) {
  $("log").textContent = text ?? "";
  $("copy-logs").hidden = !$("log").textContent;
}
function updateSyncControls() {
  sourcePdf.updateSyncControls();
}
function scheduleForwardSync() {
  sourcePdf.scheduleForwardSync();
}
function navigateSync(direction: "forward" | "backward", position: SourcePosition | { path: string; line: number; column: number }) {
  return sourcePdf.navigateSync(direction, position);
}
function updatePdfDownload() {
  $("download-pdf").disabled = operations.controlsShown || !builtPdf;
  $<HTMLButtonElement>("compile").disabled = operations.controlsShown || isBuilding(repo);
  updateSyncControls();
}
function downloadBuiltPdf() {
  if (!builtPdf) return;
  const url = URL.createObjectURL(builtPdf);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${project?.path || "main"}.pdf`;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
const { buildDocument, isBuilding } = createDocumentBuild({
  getRepo: () => repo,
  getSaving: () => documents.saving,
  getReleaseForeground: () => operations.releaseForeground,
  getBuiltPdf: () => builtPdf,
  getSyncBuild: () => sourcePdf.build,
  getStatusVersion: () => statusController.version,
  getToastBuildOperation: () => toastBuildOperation,
  setToastBuildOperation: (value) => {
    toastBuildOperation = value;
  },
  getLimits: () => serverConfig.limits,
  getLogText: () => $("log").textContent,
  saveDocument,
  status,
  updateLog,
  selectLogs: () => selectOutputTab($("logs-tab")),
  preview,
  resetPreview: () => pdfPreview.reset(),
  updatePdfDownload,
  setBuiltPdf: (value) => {
    builtPdf = value;
  },
  setEditorBusy: (value) => editor.setBusy(value),
  publishingButton: $("publishing"),
  cancelButton: $("cancel-build"),
  fs,
});
async function activate(m: ApplicationWorkspace, { build = true, focus = true } = {}) {
  if (!(await resolveEditorDraft())) return false;
  workspaceReady = false;
  selectSidebarTab($("files-tab"));
  selectOutputTab($("preview-tab"));
  $("workspace-search").value = "";
  workspaceSearch.refresh();
  sourcePdf.reset();
  builtPdf = null;
  updatePdfDownload();
  meta = m;
  if (treeClipboard?.dir !== m.dir) treeClipboard = null;
  repo = new Repository(fs, m.dir, m.links, m.modes);
  changedPaths = new Set();
  documents.path = null;
  resetImagePreview();
  selectedTreePath = null;
  loadEditorDocument();
  editor.setReadOnly(true);
  $("filename").textContent = "No file open";
  updatePageTitle();
  await pdfPreview.reset();
  updateLog("");

  $("target").value = m.branch;
  branchSelect.setValue(m.branch);
  await refresh();
  if ((await repo.files()).includes(serverConfig.mainDocument)) await openFile(serverConfig.mainDocument);
  workspaceReady = true;
  workspaceSearch.refresh();
  showView(true, { focus });
  if (!build) return;
  try {
    const result = await buildDocument();
    if (result && typeof result === "object" && result.statusHandled) return result;
    if (result === false) return false;
    status("Build complete.", "ready");
  } catch (error) {
    console.error(error);
    const detail = error.message || String(error);
    if (!$("log").textContent) updateLog(detail);
    selectOutputTab($("logs-tab"));
    status(`Build failed: ${detail}`, "error");
  }
  return { statusHandled: true };
}
async function openProject(p: ApplicationProject) {
  if (project?.id === p.id && workspaceReady) {
    if (!(await confirmWorkspaceLeave())) return false;
    selectSidebarTab($("files-tab"));
    selectOutputTab($("preview-tab"));
    $("workspace-search").value = "";
    workspaceSearch.refresh();
    if (documents.path !== serverConfig.mainDocument && (await repo.files()).includes(serverConfig.mainDocument)) await openFile(serverConfig.mainDocument);
    showView(true);
    return;
  }
  if (!(await confirmWorkspaceLeave())) return false;
  status(`Opening ${p.path_with_namespace}: loading branches…`);
  // Never leave a previous repository's editor attached to a newly selected API project.
  if (project?.id !== p.id) treeProject = null;
  project = p;
  workspaceReady = false;
  repo = null;
  changedPaths = new Set();
  meta = null;
  documents.path = null;
  resetImagePreview();
  loadEditorDocument();
  editor.setReadOnly(true);
  showView(false, { navigation: false });
  const local = Object.values(workspaces).filter((m) => m.project === p.id);
  let branches;
  try {
    branches = (await api.pages<RemoteBranch>(`projects/${p.id}/repository/branches`)).map((b) => b.name);
    targetBranchCache.set(String(p.id), branches);
  } catch (e) {
    if (!local.length) throw e;
    branches = local.map((m) => m.branch);
    status(`Could not load remote branches (${e.message}). Opening cached workspace…`);
  }
  setSidebarBranches([...new Set([...branches, ...local.map((m) => m.branch)])]);
  if (local.length) return activate(local.find((m) => m.branch === p.default_branch) || local[0]);
  else {
    branchSelect.setValue(p.default_branch || branches[0]);
    return pull();
  }
}
async function refreshRemoteBranches() {
  if (!project) throw new Error("Open a project first.");
  const activeProject = project;
  const token = $("token").value;
  const refresh = $("refresh-branches");
  refresh.dataset.loading = "true";
  refresh.setAttribute("aria-busy", "true");
  try {
    const remote = await api.pages<RemoteBranch>(`projects/${encodeURIComponent(activeProject.id)}/repository/branches`);
    if (project !== activeProject || $("token").value !== token) return false;
    const local = Object.values(workspaces)
      .filter((workspace) => String(workspace.project) === String(activeProject.id))
      .map((workspace) => workspace.branch);
    targetBranchCache.set(
      String(activeProject.id),
      remote.map(({ name }) => name),
    );
    updateTargetBranches();
    const names = [...new Set([...remote.map((branch) => branch.name), ...local])];
    const selected = $("branches").value;
    setSidebarBranches(names);
    branchSelect.setValue(names.includes(selected) ? selected : names.includes(meta?.branch) ? meta.branch : names[0] || "");
    status("Branches refreshed.", "ready");
    return { statusHandled: true };
  } finally {
    refresh.dataset.loading = "false";
    refresh.setAttribute("aria-busy", "false");
  }
}
async function pull(force = false, { build = true } = {}) {
  if (!(await resolveEditorDraft())) return false;
  const branch = $("branches").value;
  if (!branch) throw new Error("Repository has no branch. Initialize it in GitLab first.");
  const target = `${project.path_with_namespace.split("/").at(-1)} (${branch})`;
  if (
    force &&
    !(await confirmDialog(
      `Force pull ${target}?\n\nThis discards all uncommitted edits and unpublished commits in this selected branch's cached workspace, even if the remote commit has not changed.\n\nOther branches are preserved.`,
      { title: "Force pull", icon: "refresh", confirmLabel: "Force pull", confirmIcon: "force-pull", destructive: true, emphasizeText: target },
    ))
  )
    return false;
  if (!force && meta && meta.branch !== branch && !(await confirmWorkspaceLeave())) return false;
  status(force ? "Updating local files…" : `Checking remote branch ${branch}…`, "busy");
  const key = `${project.id}:${branch}`,
    previous = workspaces[key];
  if (previous && !force) {
    const old = new Repository(fs, previous.dir, previous.links, previous.modes);
    if ((await old.changes()).length || (await old.head()) !== previous.base)
      throw new Error("This branch has unpublished work. Commit and push it before pulling.");
  }
  const head = await api.request<RemoteBranch>(`projects/${project.id}/repository/branches/${encodeURIComponent(branch)}`);
  if (!force && previous?.remote === head.commit.id) return activate(previous, { build });
  const progress = createFileOperationProgress((message) => status(message, "busy"));
  const snapshot = await fetchSnapshot(api, project.id, head.commit.id, project.path_with_namespace, serverConfig.limits, (event) => {
    progress(event.phase === "listing" ? { phase: "listing" } : { phase: "downloading", completed: event.files });
  });
  // Publish only after the entire recursive import succeeds.
  const dir = `/p-${project.id}-${randomId()}`;
  const modes: ApplicationWorkspace["modes"] = {};
  const next = new Repository(fs, dir, [], modes);
  await next.init();
  let imported = 0;
  progress({ phase: "importing", completed: imported, total: snapshot.files.length });
  for (const item of snapshot.files) {
    await next.write(item.path, item.bytes);
    modes[item.path] = item.mode;
    progress({ phase: "importing", completed: ++imported, total: snapshot.files.length });
  }
  progress({ phase: "finalizing" });
  next.links = snapshot.links;
  const base = await next.commit(`Pull ${branch} @ ${head.commit.id}`, { name: "GitLab import", email: "import@aux.local" });
  const m = { project: project.id, branch, dir, remote: head.commit.id, base, modes, links: snapshot.links };
  // Keep the old cache and active editor usable if import or metadata publication fails.
  const published = { ...workspaces, [key]: m };
  persist(published);
  workspaces = published;
  showWorkspaceStatus(m.project);
  status("Opening document…", "busy");
  return activate(m, { build });
}
async function openFile(path: string, options: { source?: boolean } = {}) {
  return documents.openFile(path, options);
}
function updateEditorDraft(text: string) {
  documents.updateEditorDraft(text);
}
function loadEditorDocument(text = "", path = "") {
  documents.loadEditorDocument(text, path);
}
function saveDocument() {
  return documents.saveDocument();
}
function discardDocument(confirm = true) {
  return documents.discardDocument(confirm);
}
function resolveEditorDraft(saveLabel = "Save", discardLabel = "Discard") {
  return documents.resolveEditorDraft(saveLabel, discardLabel);
}
const outputTabs = [$("preview-tab"), $("logs-tab")];
function selectOutputTab(selected: HTMLElement, focus = false) {
  selected.closest<HTMLElement>('[role="tablist"]').dataset.activeIndex = String(outputTabs.indexOf(selected));
  for (const tab of outputTabs) {
    const active = tab === selected;
    const panel = $(tab.getAttribute("aria-controls"));
    if (!active && (panel.contains(document.activeElement) || tab === document.activeElement)) focus = true;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    panel.hidden = !active;
  }
  if (focus) selected.focus({ preventScroll: true });
}
for (const [index, tab] of outputTabs.entries()) {
  tab.onclick = () => selectOutputTab(tab);
  tab.onkeydown = (event) => {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % outputTabs.length;
    else if (event.key === "ArrowLeft") next = (index + outputTabs.length - 1) % outputTabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = outputTabs.length - 1;
    else return;
    event.preventDefault();
    selectOutputTab(outputTabs[next], true);
  };
}

sourcePdf.installUI();
function preview(blob: Blob, build: string = null, signal?: AbortSignal, report?: (message: string, state: StatusState) => void) {
  return sourcePdf.preview(blob, build, signal, report);
}
function goDocuments() {
  navigation.goDocuments();
}
$("go-documents").onclick = goDocuments;
$("home").onclick = (event) => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  goDocuments();
};
function getFileActions(): Record<string, Operation> {
  return {
    new: async () => {
      if (!(await resolveEditorDraft())) return false;
      const path = await newPath();
      if (path === null) return false;
      markWorkspace();
      await repo.write(path, new Uint8Array());
      await refresh();
      await openFile(path);
      expandTreePath(path);
    },
    "new-folder": async () => {
      const path = await newPath(true);
      if (path === null) return false;
      await repo.createDirectory(path);
      selectedTreePath = path;
      await refresh();
      expandTreePath(path);
    },
    upload: async () => $("uploads").click(),
    "upload-folder": async () => $("folder-uploads").click(),
    rename: () => {
      if (!selectedTreePath) throw new Error("Select a file or folder to rename.");
      return renamePath(selectedTreePath);
    },
    delete: async () => {
      const path = selectedTreePath;
      if (!path) return false;
      if ((documents.path === path || documents.path?.startsWith(path + "/")) && !(await resolveEditorDraft())) return false;
      repo.assertWritable(path);
      const folder = (await repo.p.stat(`${repo.dir}/${path}`)).isDirectory();
      const label = folder ? "Delete folder" : "Delete file";
      const message = `Delete ${folder ? "folder" : "file"} "${path}"?${folder ? " All files and subfolders inside it will be deleted recursively." : ""}`;
      if (!(await confirmDialog(message, { title: label, icon: "delete", confirmLabel: label, destructive: true }))) return false;
      markWorkspace();
      await repo.deletePath(path);
      selectedTreePath = null;
      await refresh();
    },
    "download-project": downloadProject,
  };
}
function saveCustomRepositories() {
  return catalogController.saveCustomRepositories();
}
function refreshDocuments(options: { background?: boolean } = {}) {
  return catalogController.refreshDocuments(options);
}
for (const [id, action] of Object.entries({
  repositories: () => refreshDocuments(),
  "refresh-branches": refreshRemoteBranches,
  pull: () => pull(),
  "force-pull": () => pull(true),

  ...getFileActions(),
  "discard-file": () => discardDocument(),
  commit,
  push,
  "create-mr": publishMergeRequest,
  "copy-logs": async () => {
    const text = $("log").textContent;
    if (!text.trim()) throw new Error("No compilation logs to copy. Run a build first.");
    try {
      await navigator.clipboard.writeText(text);
      status("Copied all logs.", "ready");
      return { statusHandled: true };
    } catch {
      // Insecure HTTP and denied clipboard permissions may require the legacy API.
    }
    const focused = document.activeElement;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.cssText = "position: fixed; top: 0; left: 0; opacity: 0; pointer-events: none;";
    document.body.append(textarea);
    try {
      textarea.focus({ preventScroll: true });
      textarea.select();
      if (!document.execCommand("copy")) throw new Error("Clipboard access was denied.");
    } catch {
      throw new Error("Could not copy logs. Select the log text and copy it manually.");
    } finally {
      textarea.remove();
      restoreFocus(focused);
    }
    status("Copied all logs.", "ready");
    return { statusHandled: true };
  },
  "download-pdf": downloadBuiltPdf,
  compile: buildDocument,
})) {
  if (id === "rename" || id === "delete") continue;
  $(id).onclick = () => {
    const label = $(id).getAttribute("aria-label") || $(id).textContent.trim() || $(id).title;
    if (["repositories", "refresh-branches", "copy-logs", "download-pdf"].includes(id)) return runBackground(action, label, id);
    if (id in getFileActions()) return invokeFileAction(id, label);
    return run(action, label, false, id === "repositories", { initialProgress: id !== "force-pull" && id !== "push", transient: id === "discard-file" });
  };
}
installShortcuts({
  ready: () => workspaceReady && !$("workspace").hidden,
  saveAndBuild: () => {
    if (!operations.busy) $("compile").click();
  },
  files: () => selectSidebarTab($("files-tab"), true),
  sync: () => selectSidebarTab($("project-tab"), true),
  preview: () => selectOutputTab($("preview-tab"), true),
  logs: () => selectOutputTab($("logs-tab"), true),
  search: () => {
    if (!workspaceSearch.available) {
      status("Workspace search unavailable. Check the page markup and reload.", "error");
      return;
    }
    selectSidebarTab($("search-tab"));
    $("workspace-search").focus();
    $("workspace-search").select();
  },
});
$("compile").title = "Save changes and build the document";
$("compile").setAttribute("aria-keyshortcuts", "Control+s Meta+s");
const uploadFiles = createFileUpload({
  ready: () => workspaceReady,
  getRepo: () => repo,
  getFile: () => documents.path,
  resolveEditorDraft,
  markWorkspace,
  refresh,
  openFile,
  getSelection: () => selectedTreePath,
  setSelection: (path) => {
    selectedTreePath = path;
  },
  expandTreePath,
  syncTree,
  uploadConflictDialog,
});
installFileUploadUI({
  tree: $("file-tree"),
  panel: $("files-panel"),
  filesInput: $("uploads"),
  folderInput: $("folder-uploads"),
  ready: () => !operations.busy && workspaceReady && !$("workspace").hidden,
  creationDirectory,
  pathWritable: treePathWritable,
  upload: (files, destination, relativePath, directory) =>
    run(() => {
      if (directory) throw new Error("Use Upload folder in the file toolbar to upload a folder.");
      return files.length ? uploadFiles(files, destination, relativePath) : false;
    }, "Uploading files"),
});
catalogView.installFilterControls();
renderCatalog();
if (setupComplete() && readStorage("aux-setup-complete") !== "false" && !catalogController.isRefreshing) {
  void refreshDocuments({ background: true }).catch((error) => console.warn("Could not refresh document metadata; showing cached documents", error));
}
// Sequential checks avoid flooding browser storage when many branches are cached.
void (async () => {
  for (const m of Object.values(workspaces)) await refreshWarning(m);
})();

void (async () => {
  if (!setupComplete() || readStorage("aux-setup-complete") === "false") await preferences.openSetup();
  document.body.classList.remove("setup-pending");
  await run(navigation.restoreActiveDocument, "Restoring document", false, false, { completion: false });
})();
