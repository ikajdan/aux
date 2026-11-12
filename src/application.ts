// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createSetupDialog } from "./ui/setup.js";
import { createThemeController } from "./ui/theme.js";
import { Buffer } from "buffer";
import { randomId } from "./random-id.js";
import { createBuildOperation } from "./workspace/build-operation.js";
import { materializeSymlinkFiles } from "./workspace/symlink-files.js";
import { serverConfig } from "./server-config.js";
import { createCatalogView, type CatalogProject } from "./projects/catalog-view.js";
import { repositoryGroupFor, fetchGroupRepositories } from "./projects/repository-groups.js";
import {
  parseCustomRepositories,
  sanitizeCustomRepositoryUrls,
  customRepositoryMatches,
  groupCatalogRepositories,
  fetchCustomRepositories,
} from "./projects/custom-repositories.js";
import { readStorage, loadSettings, loadProjects, loadWorkspaces } from "./browser-storage.js";
import {
  createMergeRequest,
  publishMergeRequestBranch,
  getProjectDefaultBranch,
  findOpenMergeRequest,
  hasOpenMergeRequest,
  type MergeRequestPublication,
  type MergeRequestResult,
} from "./gitlab-merge-request.js";
import { createProjectZip } from "./ui/project-zip.js";
import LightningFS from "@isomorphic-git/lightning-fs";
import { Repository } from "./git-repository.js";
import { configureGitLab, fetchSnapshot } from "./gitlab-submodules.js";
import { makeAPI, safePath, decode64, encode64, changedActions } from "./gitlab-sync.js";
import { icon, initializeIcons, type IconName } from "./ui-icons.js";
import { createEditor } from "./latex-editor.js";
import { createSelect } from "./select-control.js";
import { createWorkspaceSearch } from "./workspace-search.js";
import { createPreview, type SourcePosition } from "./pdf-preview.js";
import { createImagePreview, imageType } from "./image-preview.js";
import { installShortcuts } from "./keyboard-shortcuts.js";
import {
  confirmDialog,
  uploadConflictDialog,
  type UploadConflictResult,
  promptDialog,
  alertDialog,
  saveChangesDialog,
  restoreFocus,
  installBackdropCancellation,
  installInputConfirmation,
} from "./modal-dialogs.js";
import { createWorkspaceLayout, type PaneLayoutSettings } from "./workspace/pane-layout.js";
import { renderHistory as renderWorkspaceHistory } from "./workspace/change-history.js";
import { downloadBlob } from "./ui/download-blob.js";
import { operationProgress } from "./ui/operation-progress.js";
import { handleMenuKeydown } from "./ui/menu-keyboard.js";
import { createFileOperationProgress } from "./ui/file-operation-progress.js";
import { initializeDialogShells } from "./ui/dialog-shell.js";
import { localChangeBranches } from "./workspace/local-changes.js";
import { EditorDraft } from "./workspace/editor-draft.js";
import { uniqueUploadPath } from "./workspace/upload-conflicts.js";

import { validateSnapshotSizes, validateRequestSize } from "./workspace/snapshot-limits.js";
import { publishingAvailability, type MergeRequestState } from "./workspace/publishing-state.js";

configureGitLab(serverConfig.gitlabUrl);

for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-gitlab-token-link]")) {
  link.href = `${serverConfig.gitlabUrl}/-/user_settings/personal_access_tokens`;
  link.append(icon("external"));
}

declare const __APP_VERSION__: string;

type ProjectId = string | number;
interface RemoteBranch {
  name: string;
  commit: { id: string };
}
export interface ApplicationProject extends CatalogProject {
  default_branch?: string;
  pending_delete?: boolean;
  marked_for_deletion_at?: string;
  marked_for_deletion_on?: string;
}
export interface ApplicationWorkspace {
  project: ProjectId;
  branch: string;
  dir: string;
  remote: string;
  base: string;
  publication?: { localHead: string; branch: string; remoteCommit: string };
  modes: Record<string, string>;
  links?: Repository["links"];
}
interface WorkspaceWarning {
  dirty: boolean;
  unpublished: boolean;
  unpublishedCount?: number;
  pending: number;
  errors: Set<string>;
  version: number;
  known?: boolean;
  dirtyKnown?: boolean;
  draft?: boolean;
}
interface ActiveDocument {
  projectId: ProjectId;
  branch: string;
  filePath?: string;
}
interface NavigationState extends Partial<ActiveDocument> {
  session: string;
  index: number;
  view: string;
  project?: ApplicationProject;
  dir?: string;
}
interface OperationOptions {
  initialProgress?: boolean;
  completion?: boolean;
  transient?: boolean;
  allowSaveFailure?: boolean;
}
type OperationResult = void | boolean | { statusHandled: boolean };
type Operation = () => OperationResult | Promise<OperationResult>;
type Settings = PaneLayoutSettings & { token?: string; author?: string; email?: string; customRepositories?: string[]; [key: string]: unknown };
type StatusState = "busy" | "ready" | "error";
type WorkspaceStatusKind = "changes";
interface WorkspaceIndicator {
  label: string;
  branches: string[];
  kind: WorkspaceStatusKind;
  icon: IconName;
  detail: string;
}

(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
initializeDialogShells();
initializeIcons();
interface ApplicationElements {
  "app-menu": HTMLElement;
  author: HTMLInputElement;
  branches: HTMLSelectElement;
  compile: HTMLElement;
  "connection-close": HTMLElement;
  "connection-dialog": HTMLDialogElement;
  "connection-form": HTMLElement;
  "connection-status": HTMLElement;
  "copy-logs": HTMLElement;
  dashboard: HTMLElement;
  "download-pdf": HTMLButtonElement;
  editor: HTMLElement;
  email: HTMLInputElement;
  "file-tree": HTMLElement;
  filename: HTMLElement;
  "file-read-only": HTMLElement;
  "discard-file": HTMLButtonElement;
  "files-panel": HTMLElement;
  "files-tab": HTMLElement;
  "folder-uploads": HTMLInputElement;
  "go-documents": HTMLElement;
  history: HTMLElement;
  home: HTMLAnchorElement;
  "image-preview": HTMLElement;
  log: HTMLElement;
  "logs-tab": HTMLElement;
  message: HTMLInputElement;

  "mr-title": HTMLInputElement;
  "mr-help": HTMLElement;
  "mr-result": HTMLElement;
  "create-mr": HTMLButtonElement;
  pdf: HTMLElement;
  "preview-empty": HTMLElement;
  "preview-tab": HTMLElement;
  "project-branch": HTMLElement;
  "project-clear-filters": HTMLElement;
  "project-topic-filters": HTMLElement;
  "project-link": HTMLAnchorElement;
  "project-panel": HTMLElement;
  "project-search": HTMLInputElement;
  "project-search-panel": HTMLElement;
  "project-tab": HTMLElement;
  publishing: HTMLButtonElement;
  "publishing-close": HTMLElement;
  "publishing-dialog": HTMLDialogElement;

  repos: HTMLElement;
  repositories: HTMLElement;
  "repositories-heading": HTMLElement;
  "search-tab": HTMLElement;
  "settings-title-text": HTMLElement;
  "setup-close": HTMLButtonElement;
  "setup-dialog": HTMLDialogElement;
  "setup-form": HTMLElement;
  "setup-next": HTMLButtonElement;
  "setup-next-label": HTMLElement;
  "setup-status": HTMLElement;
  "save-settings": HTMLButtonElement;
  "restore-settings": HTMLButtonElement;
  "setup-token": HTMLInputElement;
  "setup-token-error": HTMLElement;
  shortcuts: HTMLElement;
  "shortcuts-close": HTMLElement;
  "shortcuts-dialog": HTMLDialogElement;
  status: HTMLElement;
  "status-toast": HTMLElement;
  "cancel-build": HTMLButtonElement;
  "sync-source-pdf": HTMLButtonElement;

  target: HTMLInputElement;
  "target-remote-branches": HTMLSelectElement;
  title: HTMLElement;
  token: HTMLInputElement;
  "token-error": HTMLElement;
  uploads: HTMLInputElement;
  workspace: HTMLElement;
  "workspace-search": HTMLInputElement;
  "workspace-search-results": HTMLElement;
  "workspace-search-status": HTMLElement;
}
function $<K extends keyof ApplicationElements>(id: K): ApplicationElements[K];
function $<T extends HTMLElement = HTMLElement>(id: string): T;
function $(id: string): HTMLElement {
  return document.getElementById(id);
}
const branchSelect = createSelect($("branches"));
const targetBranchSelect = createSelect($("target-remote-branches"));
const theme = createThemeController({
  root: document.documentElement,
  groups: [...document.querySelectorAll<HTMLElement>(".theme-options")],
  savedThemeValue: readStorage("aux-theme"),
  media: matchMedia,
  storage: { setItem: (key, value) => localStorage.setItem(key, value) },
  setupStatus: $("setup-status"),
  reportSettingsError: (message) => settingsStatus(message, "error"),
});
const editorDraft = new EditorDraft();
let documentGeneration = 0;
const editor = createEditor($("editor"), updateEditorDraft, scheduleForwardSync);
const imagePreview = createImagePreview($("image-preview"));
let fileOpenGeneration = 0;
function resetImagePreview() {
  fileOpenGeneration++;
  imagePreview.reset();
  $("editor").hidden = false;
}
const pdfPreview = createPreview($("pdf"), $("preview-empty"), status, (position) => {
  void navigateSync("backward", position);
});
theme.connectEditor((value) => editor.setTheme(value));
const fs = new LightningFS("aux-workspaces-v1");
const api = makeAPI(() => $("token").value);
let settings: Settings = loadSettings();
let customRepositories: string[] = [];
try {
  customRepositories = parseCustomRepositories((settings.customRepositories || []).join("\n"), serverConfig.gitlabUrl);
} catch {
  // Ignore invalid cached paths rather than blocking startup.
}
const workspaceLayout = createWorkspaceLayout(
  () => settings,
  (next) => {
    settings = next;
  },
);
let catalog: ApplicationProject[] = loadProjects();

const catalogView = createCatalogView({
  repos: $("repos"),
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
let catalogGeneration = 0;
let documentsRefresh: Promise<void> = null;
let tagQueue = Promise.resolve();
function showLatestTag(p: ApplicationProject) {
  catalogView.showLatestTag(p);
}
function fetchCatalogTags(generation: number, progress?: (completed: number, total: number) => void, { refreshAll = false } = {}) {
  const projects = catalog.filter((p) => isAvailableProject(p) && (refreshAll || p.latestTag === undefined));
  const token = $("token").value;
  if (!token.trim()) return Promise.resolve();
  // Drain superseded requests before starting another pool, keeping the total at four.
  tagQueue = tagQueue
    .catch(() => {})
    .then(async () => {
      let next = 0;
      let completed = 0;
      const current = () => generation === catalogGeneration && token === $("token").value;
      async function worker() {
        while (current() && next < projects.length) {
          const p = projects[next++];
          try {
            const endpoint = `projects/${encodeURIComponent(p.id)}/repository/tags`;
            let tags;
            try {
              tags = await api.request(`${endpoint}?order_by=version&sort=desc&per_page=1`);
            } catch (error) {
              if (
                error.status !== 400 ||
                !/order_by/i.test(error.message) ||
                !/version|invalid|unsupported|not.*(?:valid|support)|allowed/i.test(error.message)
              )
                throw error;
              // Older GitLab releases cannot order by semantic version.
              tags = await api.request(`${endpoint}?order_by=updated&sort=desc&per_page=1`);
            }
            if (!Array.isArray(tags) || (tags.length && typeof tags[0]?.name !== "string")) throw new Error("Invalid GitLab tags response");
            if (!current()) return;
            p.latestTag = tags.length ? tags[0].name : null;
            showLatestTag(p);
          } catch (error) {
            console.warn(`Could not retrieve latest tag for project ${p.id}`, error);
          }
          if (!current()) return;
          completed++;
          progress?.(completed, projects.length);
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, projects.length) }, worker));
      if (current()) localStorage.setItem("aux-projects", JSON.stringify(catalog));
    });
  return tagQueue;
}
let workspaces: Record<string, ApplicationWorkspace> = loadWorkspaces();
let project: ApplicationProject;
let repo: Repository;
let meta: ApplicationWorkspace;
let file: string;
let selectedTreePath: string;
let changedPaths = new Set<string>();
let builtPdf: Blob;
let saving: Promise<void> = Promise.resolve();
const pendingFileSaves = new Map<string, number>();
function hasUnsavedDocument() {
  return editorDraft.dirty || Boolean(file && workspaceWarnings.get(meta?.dir)?.errors.has(file));
}
function updateFilenameSaveState() {
  const key = repo && file ? `${repo.dir}/${file}` : "";
  const unsaved = Boolean(editorDraft.dirty || (key && (pendingFileSaves.has(key) || workspaceWarnings.get(meta?.dir)?.errors.has(file))));
  $("filename").classList.toggle("unsaved", unsaved);
  $("file-read-only").hidden = !file || editor.canEdit();
  $("discard-file").closest<HTMLElement>(".editor-save-actions").hidden = !editor.canEdit();
  $("discard-file").disabled = busy || !file || !hasUnsavedDocument();
}
let busy = false;
let busyControlsShown = false;
let workspaceReady = false;
let treeProject: ProjectId;
let syncBuild: string = null;
let syncActive = true;
let syncTimer: ReturnType<typeof setTimeout>;
let syncRequest: AbortController;
let syncSequence = 0;
let syncError = "";
let syncGeneration = 0;
// Unknown cached repositories are conservatively risky until their first status check.
const workspaceWarnings = new Map<string, WorkspaceWarning>();
function warningState(m: ApplicationWorkspace) {
  if (!workspaceWarnings.has(m.dir)) workspaceWarnings.set(m.dir, { dirty: true, unpublished: true, pending: 0, errors: new Set(), version: 0 });
  return workspaceWarnings.get(m.dir);
}
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
  const p = catalog.find((p) => String(p.id) === String(id));
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
    branchSelect.setOptions(local.map((m) => m.branch));
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
  if (!editorDraft.dirty && !(busy && repo) && ![...workspaceWarnings.values()].some((state) => state.pending > 0 || state.errors.size > 0)) return;
  event.preventDefault();
  event.returnValue = "";
});

for (const key of ["token", "author", "email"] as const) $<HTMLInputElement>(key).value = settings[key] || "";
$<HTMLTextAreaElement>("custom-repositories").value = customRepositories.join("\n");
$<HTMLTextAreaElement>("custom-repositories").addEventListener("paste", (event) => {
  const pasted = event.clipboardData?.getData("text/plain");
  if (!pasted) return;
  const sanitized = sanitizeCustomRepositoryUrls(pasted);
  if (sanitized === pasted) return;
  event.preventDefault();
  const input = event.currentTarget as HTMLTextAreaElement;
  input.setRangeText(sanitized, input.selectionStart, input.selectionEnd, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
function setupComplete() {
  const email = document.createElement("input");
  email.type = "email";
  email.value = typeof settings.email === "string" ? settings.email.trim() : "";
  return ["token", "author", "email"].every((key) => typeof settings[key] === "string" && settings[key].trim()) && email.validity.valid;
}
let settingsSnapshot: { settings: Settings; repositories: string[]; theme: string };
function openConnection() {
  $("connection-status").textContent = "";
  $("custom-repositories-status").textContent = "";
  $("settings-title-text").textContent = "Settings";
  if (!$("connection-dialog").open) {
    settingsSnapshot = { settings: { ...settings }, repositories: [...customRepositories], theme: theme.selectedTheme };
    $("connection-dialog").showModal();
  }
  updatePageTitle();
}
for (const id of ["connection-dialog", "publishing-dialog", "shortcuts-dialog"]) installBackdropCancellation($(id));
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
$("app-menu").onclick = openConnection;
$("connection-dialog").onclose = () => {
  saveSettingsFields();
  void saveCustomRepositories().catch((error) => status(error.message, "error"));
  updatePageTitle();
  $("app-menu").focus();
};

const targetBranchCache = new Map<string, string[]>();
function updateTargetBranches(names = targetBranchCache.get(String(project?.id)) || []) {
  const select = $("target-remote-branches");
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.hidden = true;
  placeholder.disabled = true;
  placeholder.selected = true;
  placeholder.textContent = names.length ? "Existing branch…" : "No remote branches";
  select.replaceChildren(
    placeholder,
    ...[...new Set(names)]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        return option;
      }),
  );
  select.disabled = busy || currentPublishingAvailability().pushDisabled || !names.length;
  targetBranchSelect.rebuild();
}
$("target-remote-branches").onchange = () => {
  const selected = $("target-remote-branches").value;
  if (busy || !selected) return;
  $("target").value = selected;
  targetBranchSelect.setValue("");
  $("target").dispatchEvent(new Event("input", { bubbles: true }));
  $("target").focus();
};
async function loadTargetBranches() {
  const activeProject = project;
  const token = $("token").value;
  if (!activeProject) return;
  try {
    const remote = await api.pages<RemoteBranch>(`projects/${encodeURIComponent(activeProject.id)}/repository/branches`);
    if (project !== activeProject || $("token").value !== token) return;
    targetBranchCache.set(
      String(activeProject.id),
      remote.map(({ name }) => name),
    );
    updateTargetBranches();
  } catch (error) {
    if (project === activeProject && $("token").value === token) status(`Could not refresh remote branches: ${error.message}`, "error");
  }
}
async function openPublishing() {
  if ($("publishing-dialog").open) return;
  if (!(await resolveEditorDraft("Save and continue", "Discard and continue"))) return false;
  $("mr-result").textContent = "";

  if (!$("publishing-dialog").open) $("publishing-dialog").showModal();
  updateTargetBranches();
  void loadTargetBranches();
  const pending = pendingMergeRequest();
  $("mr-title").value = pending?.title || "";
  void refreshBranchMergeRequest();
  if (meta && repo) void refreshWarning(meta, repo);
  updatePageTitle();
}
$("publishing").onclick = () =>
  run(openPublishing, "Opening Publish Changes", true, false, {
    completion: false,
    allowSaveFailure: true,
    transient: true,
  });

$("publishing-dialog").onclose = () => {
  mergeRequestCheckSequence++;
  updatePageTitle();
  if ($("workspace").hidden) $("repositories-heading").focus();
  else if ($("project-panel").hidden) sidebarTabs.find((tab) => tab.getAttribute("aria-selected") === "true").focus();
  else $("publishing").focus();
};
for (const [input, action] of [
  ["message", "commit"],
  ["target", "push"],
  ["mr-title", "create-mr"],
] as const) {
  installInputConfirmation($<HTMLInputElement>(input), $<HTMLButtonElement>(action));
}
const settingsKeys = ["token", "author", "email"] as const;
let persistenceRequested = false;
const failedSettings = new Set();
function settingsStatus(text: string, state: StatusState = "ready") {
  $("connection-status").textContent = text;
  $("connection-status").dataset.state = state;
}
function saveSettingsField(key: (typeof settingsKeys)[number], validate = false) {
  const input = $<HTMLInputElement>(key);
  const value = input.value.trim();
  const error = $(`${key}-error`);
  const changed = value !== (settings[key] || "");
  if (!changed && !validate && !input.hasAttribute("aria-invalid")) return;
  const message = !value
    ? { token: "Enter a personal access token.", author: "Enter an author name.", email: "Enter an email address." }[key]
    : key === "email" && !input.validity.valid
      ? "Enter a valid email address, such as name@example.com."
      : "";
  error.textContent = message;
  error.hidden = !message;
  if (message) {
    input.setAttribute("aria-invalid", "true");
    if (!failedSettings.size) settingsStatus("");
    return;
  }
  input.removeAttribute("aria-invalid");
  input.value = value;
  if (!changed) return;
  const next = { ...settings, [key]: value };
  try {
    localStorage.setItem("aux-settings", JSON.stringify(next));
  } catch (error) {
    console.warn("Could not save settings", error);
    failedSettings.add(key);
    settingsStatus("Could not save settings. Try again.", "error");
    return;
  }
  settings = next;
  failedSettings.delete(key);
  settingsStatus(failedSettings.size ? "Could not save settings. Try again." : "", failedSettings.size ? "error" : "ready");
  if (!persistenceRequested) {
    persistenceRequested = true;
    Promise.resolve()
      .then(() => navigator.storage?.persist?.())
      .catch((error) => {
        console.warn("Could not request persistent storage", error);
      });
  }
}
function saveSettingsFields(validate = false) {
  for (const key of settingsKeys) saveSettingsField(key, validate);
}
for (const key of settingsKeys) {
  $<HTMLInputElement>(key).addEventListener("blur", () => saveSettingsField(key, true));
  $<HTMLInputElement>(key).addEventListener("input", () => {
    if (!failedSettings.size) settingsStatus("");
  });
  $<HTMLInputElement>(key).addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    $("connection-form").dispatchEvent(new Event("submit", { cancelable: true }));
  });
}
async function saveAllSettings() {
  $("custom-repositories-status").textContent = "";
  saveSettingsFields(true);
  const invalid = settingsKeys.map((key) => $<HTMLInputElement>(key)).find((input) => input.hasAttribute("aria-invalid"));
  if (invalid || failedSettings.size) {
    if (invalid) {
      settingsStatus("Check the highlighted fields.", "error");
      restoreFocus(invalid);
    }
    return false;
  }
  settingsStatus("");
  await saveCustomRepositories();
  if (!$("custom-repositories-status").textContent) settingsStatus("Settings saved.");
}
async function restoreSettings() {
  if (!settingsSnapshot) return false;
  const snapshot = settingsSnapshot;
  const next = {
    ...settings,
    token: snapshot.settings.token,
    author: snapshot.settings.author,
    email: snapshot.settings.email,
    customRepositories: [...snapshot.repositories],
  };
  const refresh = (settings.token || "") !== (next.token || "") || JSON.stringify(customRepositories) !== JSON.stringify(snapshot.repositories);
  try {
    const previous = localStorage.getItem("aux-settings");
    localStorage.setItem("aux-settings", JSON.stringify(next));
    try {
      theme.selectTheme(snapshot.theme);
    } catch (error) {
      if (previous === null) localStorage.removeItem("aux-settings");
      else localStorage.setItem("aux-settings", previous);
      throw error;
    }
  } catch (error) {
    console.warn("Could not restore settings", error);
    settingsStatus("Could not restore settings in this browser. Try again.", "error");
    return false;
  }
  settings = next;
  customRepositories = [...snapshot.repositories];
  failedSettings.clear();
  for (const key of settingsKeys) {
    $(key).value = settings[key] || "";
    $(key).removeAttribute("aria-invalid");
    $(`${key}-error`).textContent = "";
    $(`${key}-error`).hidden = true;
  }
  $<HTMLTextAreaElement>("custom-repositories").value = customRepositories.join("\n");
  $("custom-repositories").removeAttribute("aria-invalid");
  $("custom-repositories-status").textContent = "";
  settingsStatus("Settings restored.");
  if (refresh) {
    renderCatalog();
    try {
      await refreshDocuments();
      settingsStatus("Settings restored. Documents refreshed.");
    } catch (error) {
      settingsStatus(`Settings restored. Could not refresh documents: ${error.message}`, "error");
      return false;
    }
  }
}
function runSettingsAction(action: Operation, label: string) {
  const buttons = [$("save-settings"), $("restore-settings")];
  if (busy || buttons.some((button) => button.disabled)) return;
  buttons.forEach((button) => {
    button.disabled = true;
  });
  void run(action, label, false, false, { initialProgress: false, completion: false, allowSaveFailure: true }).finally(() => {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  });
}
$("connection-form").onsubmit = (event) => {
  event.preventDefault();
  runSettingsAction(saveAllSettings, "Save settings");
};
$("restore-settings").onclick = () => runSettingsAction(restoreSettings, "Restore settings");

const openSetup = createSetupDialog({
  getSettings: () => settings,
  validateToken: (candidate) => makeAPI(() => candidate).request<{ id: number }>("user"),
  saveField: (key) => {
    saveSettingsField(key, true);
    return !failedSettings.has(key);
  },
  persistTheme: () => theme.selectTheme(theme.selectedTheme),
  refreshDocuments: () => refreshDocuments({ background: true }),
});
function persist(next = workspaces) {
  localStorage.setItem("aux-workspaces", JSON.stringify(next));
}

let statusTimer: ReturnType<typeof setTimeout>;
let statusVersion = 0;
let toastBuildOperation: ReturnType<typeof createBuildOperation> | null = null;
function dismissStatus() {
  clearTimeout(statusTimer);
  statusVersion++;
  $("status").replaceChildren();
  $("cancel-build").hidden = true;
  const toast = $("status-toast");
  if (toast.matches(":popover-open")) toast.hidePopover();
  toast.hidden = true;
}
function formatStatusMessage(text: unknown, state: StatusState) {
  const message = String(text ?? "").trimEnd();
  if (!message || /[.!?…]["'’”)\]]*$/.test(message)) return message;
  return message + (state === "busy" ? "…" : ".");
}
function status(text: string, state: StatusState = busy ? "busy" : "ready") {
  text = formatStatusMessage(text, state);
  if (!text) {
    dismissStatus();
    return;
  }
  clearTimeout(statusTimer);
  const version = ++statusVersion;
  const content = $("status");
  if (content.dataset.state === state && content.lastChild?.nodeType === Node.TEXT_NODE) content.lastChild.textContent = text;
  else content.replaceChildren(icon(state), document.createTextNode(text));
  content.dataset.state = state;
  $("cancel-build").hidden = state !== "busy" || !toastBuildOperation || toastBuildOperation.signal.aborted;
  const toast = $("status-toast");
  toast.hidden = false;
  if (!toast.matches(":popover-open")) toast.showPopover();
  if (text && (state === "ready" || state === "error")) {
    statusTimer = setTimeout(
      () => {
        if (version === statusVersion) dismissStatus();
      },
      state === "error" ? 8000 : 5000,
    );
  }
}
function button(text: string, action: Operation, iconName: IconName = "file", quiet = false, options: OperationOptions = {}) {
  const b = document.createElement("button");
  b.append(icon(iconName), document.createTextNode(text));
  b.type = "button";
  b.onclick = () => run(action, text, quiet, false, options);
  return b;
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
  busyControlsShown = !transient;

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
    busyControlsShown = true;
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
  try {
    if (allowSaveFailure) await saving.catch(() => {});
    else await saving;
    const result = await action();
    if (repo) {
      try {
        await fs.promises.flush();
        for (const state of workspaceWarnings.values()) state.errors.delete("[workspace storage]");
      } catch (error) {
        if (meta) warningState(meta).errors.add("[workspace storage]");
        throw error;
      }
    }
    if (!quiet && !(result && typeof result === "object" && result.statusHandled)) {
      if (result === false || !completion) dismissStatus();
      else status(`${label} complete.`, "ready");
    }
  } catch (e) {
    console.error(e);
    const detail = e.name === "TimeoutError" ? "Request timed out. Check the connection and try again." : e.message || String(e);
    status(`${label} failed: ${detail}`, "error");
  } finally {
    if (meta && repo) await refreshWarning(meta, repo);
    clearTimeout(busyTimer);
    if (disabled) controls.forEach((c, i) => (c.disabled = disabled[i]));
    branchSelect.sync();
    busy = false;
    busyControlsShown = false;

    updateMergeRequestControls();
    updatePdfDownload();
    syncTree();
    $("workspace").setAttribute("aria-busy", "false");
    editor.setBusy(false);
    updateFilenameSaveState();
    const searchPanel = $("project-search-panel");
    if (!searchPanel || !searchPanel.contains(document.activeElement)) restoreFocus(previousFocus);
    void processNavigation();
  }
}
const sidebarTabs = [$("files-tab"), $("search-tab"), $("project-tab")];
const workspaceSearch = createWorkspaceSearch({
  panel: $("project-search-panel"),
  input: $("workspace-search"),
  status: $("workspace-search-status"),
  results: $("workspace-search-results"),
  context: () => (repo && workspaceReady ? { repo, saved: saving, path: editor.getPath(), text: editor.getText() } : null),
  open: async (source, path, match) => {
    if (busy) throw new Error("Wait for the current operation to finish before opening a result.");
    await run(
      async () => {
        if (source !== repo) return;
        if ((await openFile(path, { source: true })) === false) return false;
        if (source === repo && file === path) editor.goToLine(match.line, match.column);
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
  path.textContent = file || "No file open";
  $("filename").replaceChildren(path);
  $("filename").title = file || "";
  updateFilenameSaveState();
  const workspaceVisible = !$("workspace").hidden;
  const name = workspaceVisible ? project?.name || (project?.path || project?.path_with_namespace || "").split("/").pop() : "";
  if ($("shortcuts-dialog").open) document.title = `Keyboard shortcuts${name ? ` — ${name}` : ""} · Aux`;
  else if ($("connection-dialog").open) document.title = "Settings · Aux";
  else if ($("publishing-dialog").open) document.title = `Publish Changes${name ? ` — ${name}` : ""} · Aux`;
  else if (name) document.title = `${file ? `${file} — ` : ""}${name}${meta?.branch ? ` (${meta.branch})` : ""} · Aux`;
  else document.title = "Documents · Aux";
}
function validNavigation(value: unknown) {
  const candidate = value as Partial<NavigationState>;
  return (
    candidate &&
    typeof candidate.session === "string" &&
    Number.isSafeInteger(candidate.index) &&
    candidate.index >= 0 &&
    ["documents", "editor"].includes(candidate.view)
  );
}
function validDocument(value: unknown) {
  const candidate = value as Partial<ActiveDocument>;
  return (
    candidate &&
    ["string", "number"].includes(typeof candidate.projectId) &&
    String(candidate.projectId).length > 0 &&
    typeof candidate.branch === "string" &&
    candidate.branch.length > 0 &&
    (candidate.filePath == null || typeof candidate.filePath === "string")
  );
}
const initialNavigation = validNavigation(history.state?.auxView) ? history.state.auxView : null;
let savedDocument: ActiveDocument = null;
try {
  const value = JSON.parse(localStorage.getItem("aux-active-document") || "null");
  if (validDocument(value)) savedDocument = value;
} catch (error) {
  console.warn("Could not read active document", error);
}
const historyDocument =
  initialNavigation?.view === "editor" ? { ...initialNavigation, projectId: initialNavigation.projectId ?? initialNavigation.project?.id } : null;
const startupDocument = validDocument(historyDocument) ? historyDocument : initialNavigation?.view === "documents" ? null : savedDocument;
const historySession = initialNavigation?.session || randomId();
let currentNavigation: NavigationState = initialNavigation || { session: historySession, index: 0, view: "documents" };
let restoringDocument = false;

function persistActiveDocument(editor = !$("workspace").hidden) {
  if (restoringDocument) return;
  const location = editor && project && meta ? { projectId: project.id, branch: meta.branch, filePath: file } : null;
  try {
    if (location) localStorage.setItem("aux-active-document", JSON.stringify(location));
    else localStorage.removeItem("aux-active-document");
  } catch (error) {
    console.warn("Could not save active document", error);
  }
  if (location && currentNavigation.view === "editor" && !handlingNavigation && !pendingNavigation) recordNavigation(true);
}
let pendingNavigation: NavigationState = null;
let handlingNavigation = false;
if (!initialNavigation) history.replaceState({ ...history.state, auxView: currentNavigation }, "");

function recordNavigation(editor: boolean) {
  if (handlingNavigation || pendingNavigation) return;
  const next = editor
    ? {
        session: historySession,
        index: currentNavigation.index,
        view: "editor",
        project,
        projectId: project.id,
        branch: meta.branch,
        dir: meta.dir,
        filePath: file,
      }
    : { session: historySession, index: currentNavigation.index, view: "documents" };
  const push = editor && currentNavigation.view === "documents";
  if (push) next.index++;
  history[push ? "pushState" : "replaceState"]({ ...history.state, auxView: next }, "");
  currentNavigation = next;
}

window.addEventListener("popstate", (event) => {
  const next = event.state?.auxView;
  if (next?.session !== historySession) return;
  pendingNavigation = next;
  void processNavigation();
});

async function processNavigation() {
  if (busy || handlingNavigation || !pendingNavigation) return;
  const next = pendingNavigation;
  pendingNavigation = null;
  if (next.index === currentNavigation.index) return;
  handlingNavigation = true;
  await run(
    async () => {
      try {
        if (!(await confirmWorkspaceLeave())) {
          const actual = history.state?.auxView;
          if (actual?.session === historySession && actual.index !== currentNavigation.index) history.go(currentNavigation.index - actual.index);
          pendingNavigation = null;
          return false;
        }
        if (next.view === "editor") {
          const cached = Object.values(workspaces).find(
            (m) => String(m.project) === String(next.project?.id) && m.branch === next.branch && m.dir === next.dir,
          );
          if (cached && workspaceReady && String(project?.id) === String(cached.project) && meta?.dir === cached.dir && meta?.branch === cached.branch) {
            showView(true);
          } else if (cached) {
            treeProject = null;
            project = next.project;
            branchSelect.setOptions(
              Object.values(workspaces)
                .filter((m) => String(m.project) === String(project.id))
                .map((m) => m.branch),
            );
            await activate(cached, { build: false });
          } else {
            showView(false);
            next.view = "documents";
            history.replaceState({ ...history.state, auxView: next }, "");
          }
        } else {
          showView(false);
        }
        currentNavigation = next;
        persistActiveDocument(next.view === "editor");
      } catch (error) {
        const actual = history.state?.auxView;
        if (actual?.session === historySession && actual.index !== currentNavigation.index) history.go(currentNavigation.index - actual.index);
        throw error;
      }
    },
    "Navigation",
    true,
    false,
    { allowSaveFailure: true },
  );
  handlingNavigation = false;
  void processNavigation();
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
  $("project-link").replaceChildren(projectTopic, icon("external"));
  $("project-link").title = `Open ${projectName} in GitLab`;
  $("project-link").setAttribute("aria-label", `Open ${projectName} in GitLab`);
  const branchLabel = document.createElement("span");
  branchLabel.className = "project-branch-label";
  branchLabel.textContent = editor ? meta.branch : "";
  $("project-branch").replaceChildren(icon("branch"), branchLabel);
  $("project-branch").title = "Open Sync tab";
  $("project-branch").setAttribute("aria-label", editor ? `Open Sync tab for branch ${meta.branch}` : "Open Sync tab");

  if (editor) {
    $("project-link").href = `${serverConfig.gitlabUrl}/${project.path_with_namespace.split("/").map(encodeURIComponent).join("/")}`;
  } else {
    $("project-link").removeAttribute("href");
  }
  const target = editor ? sidebarTabs.find((tab) => tab.getAttribute("aria-selected") === "true").id : "repositories-heading";
  if (focus) $(target).focus();
}
function isAvailableProject(project: ApplicationProject) {
  return !(
    project.pending_delete ||
    project.marked_for_deletion_at ||
    project.marked_for_deletion_on ||
    [project.name, project.path, project.path_with_namespace].some((value) => /-deletion_scheduled-\d+$/i.test(value || ""))
  );
}
let lastRepositoriesRefresh = Number(readStorage("aux-last-repositories-refresh"));
function updateRepositoryTimes() {
  catalogView.updateRepositoryTimes(lastRepositoriesRefresh);
}
updateRepositoryTimes();
setInterval(updateRepositoryTimes, 60000);

function setDashboardRefreshing(refreshing: boolean) {
  catalogView.setRefreshing(refreshing);
}
catalogView.installRefreshGuards();
function renderCatalog() {
  catalog = catalog.filter(
    (project) =>
      isAvailableProject(project) && (repositoryGroupFor(project, serverConfig.repositoryGroups) || customRepositoryMatches(project, customRepositories)),
  );
  catalogView.render(catalog, customRepositories, lastRepositoriesRefresh);
}
async function downloadFile(path: string) {
  if (!path) return;
  if (path === file && !(await resolveEditorDraft())) return false;
  downloadBlob(new Blob([(await fs.promises.readFile(`${repo.dir}/${path}`)) as Uint8Array<ArrayBuffer>]), path.split("/").pop());
}
function treePathWritable(path: string) {
  if (!repo || !path) return false;
  try {
    repo.assertWritable(path);
    return true;
  } catch {
    return false;
  }
}
let treeMenu: HTMLDivElement;
let treeMenuOrigin: HTMLElement;
let treeClipboard: { dir: string; path: string; type: "copy" | "cut" };
async function downloadProject() {
  if (!(await resolveEditorDraft())) return false;
  let name = project?.path || "document";
  name = name.replace(/[\\/\\\\\x00-\x1f<>:"|?*]/g, "-").replace(/[. ]+$/g, "");
  if (!name || name === "." || name === ".." || name.toLowerCase() === ".git") name = "document";
  safePath(name);
  const entries = Object.create(null);
  entries[`${name}/`] = new Uint8Array();
  const [paths, directories] = await Promise.all([repo.files(), repo.directories()]);
  for (const path of directories) entries[`${name}/${safePath(path)}/`] = new Uint8Array();
  for (const path of paths) entries[`${name}/${safePath(path)}`] = new Uint8Array(await repo.p.readFile(`${repo.dir}/${path}`));
  const bytes = await createProjectZip(entries);
  downloadBlob(new Blob([bytes], { type: "application/zip" }), `${name}.zip`);
}
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
  if (!treeMenu) return;
  treeMenu.remove();
  treeMenu = null;
  const origin = treeMenuOrigin;
  treeMenuOrigin = null;
  if (focus && origin?.isConnected) origin.focus({ preventScroll: true });
}
function openTreeMenu(event: MouseEvent) {
  event.preventDefault();
  closeTreeMenu();
  if (busy || !repo || !workspaceReady) return;
  const tree = $("file-tree");
  const row = (event.target as HTMLElement).closest<HTMLElement>("button[data-path], summary[data-path]");
  const path = row?.dataset.path || "";
  selectedTreePath = path;
  syncTree();
  treeMenuOrigin = row || tree;
  treeMenuOrigin.focus({ preventScroll: true });
  const menu = document.createElement("div");
  treeMenu = menu;
  menu.dataset.treeMenu = "";
  menu.tabIndex = -1;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "File actions");
  const actions: [IconName, string][] = row?.matches("button")
    ? [
        ["rename", "Rename"],
        ["copy", "Copy"],
        ["cut", "Cut"],
        ["paste", "Paste"],
        ["download", "Download"],
        ["delete", "Delete"],
      ]
    : [
        ...(row ? [["rename", "Rename"] as [IconName, string]] : []),
        ["new", "New file"],
        ["new-folder", "New folder"],
        ...(row ? [["copy", "Copy"] as [IconName, string], ["cut", "Cut"] as [IconName, string]] : []),
        ["paste", "Paste"],
        ...(row ? [["delete", "Delete"] as [IconName, string]] : []),
      ];
  const destination = row?.matches("button") ? path.split("/").slice(0, -1).join("/") : path;
  for (const [id, label] of actions) {
    const item = document.createElement("button");
    item.type = "button";
    item.tabIndex = -1;
    item.setAttribute("role", "menuitem");
    item.dataset.action = id;
    item.append(icon(id), document.createTextNode(label));
    if (["copy", "cut", "paste"].includes(id)) {
      item.title = `${label} within this workspace`;
      item.disabled =
        id === "cut"
          ? !treePathWritable(path)
          : id === "paste"
            ? !treeClipboard ||
              treeClipboard.dir !== repo.dir ||
              Boolean(destination && !treePathWritable(destination)) ||
              destination === treeClipboard.path ||
              destination.startsWith(treeClipboard.path + "/")
            : false;
    } else item.disabled = id === "download" ? false : fileActionDisabled(id);
    item.onclick = () => {
      closeTreeMenu(true);
      if (busy) return;
      if (id === "download") void run(() => downloadFile(path), "Download");
      else if (id === "copy" || id === "cut") setTreeClipboard(path, id);
      else if (id === "paste") void run(() => pasteTreePath(destination), "Paste");
      else void invokeFileAction(id, label);
    };
    menu.append(item);
  }
  menu.onkeydown = (event) => {
    const items = [...menu.querySelectorAll<HTMLElement>("button:not(:disabled)")];
    handleMenuKeydown(event, items, document.activeElement, () => closeTreeMenu(true));
  };
  document.body.append(menu);
  const { clientX: x, clientY: y } = event;
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4))}px`;
  const firstItem = menu.querySelector<HTMLButtonElement>("button:not(:disabled)") || menu;
  firstItem.focus({ preventScroll: true });
}
$("file-tree").tabIndex = 0;
$("file-tree").addEventListener("contextmenu", (event) => openTreeMenu(event));

document.addEventListener(
  "pointerdown",
  (event) => {
    if (treeMenu && !treeMenu.contains(event.target as Node)) closeTreeMenu();
  },
  true,
);
document.addEventListener("focusin", (event) => {
  if (treeMenu && !treeMenu.contains(event.target as Node)) closeTreeMenu();
});
document.addEventListener("scroll", () => closeTreeMenu(true), true);
window.addEventListener("resize", () => closeTreeMenu(true));
window.addEventListener("popstate", () => closeTreeMenu());
function syncTree() {
  const changedDirectories = new Set();
  const editedPaths = new Set([...changedPaths, ...(editorDraft.dirty && file ? [file] : [])]);
  for (const path of editedPaths) {
    const parts = path.split("/");
    while (parts.length > 1) {
      parts.pop();
      changedDirectories.add(parts.join("/"));
    }
  }
  for (const item of $("file-tree").querySelectorAll<HTMLElement>("button[data-path], summary[data-path]")) {
    item.dataset.selected = String(item.dataset.path === selectedTreePath);
    item.classList.toggle(
      "tree-cut",
      treeClipboard?.dir === repo?.dir &&
        treeClipboard?.type === "cut" &&
        (item.dataset.path === treeClipboard.path || item.dataset.path.startsWith(treeClipboard.path + "/")),
    );
    item.classList.toggle("tree-modified", editedPaths.has(item.dataset.path) || (item.matches("summary") && changedDirectories.has(item.dataset.path)));
    if (item.matches("button") && item.dataset.path === file) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  for (const id of ["new", "new-folder", "upload", "upload-folder", "download-project"]) $<HTMLButtonElement>(id).disabled = fileActionDisabled(id);
}
function fileActionDisabled(id: string) {
  if (busy || !workspaceReady || !repo) return true;
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
  if (file && movedPath(file) !== file) {
    file = movedPath(file);
    editor.setPath(file);
    imagePreview.rename(file);
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
  const selected = selectedTreePath ?? file;
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
  for (const details of $("file-tree").querySelectorAll("details")) {
    if (path === details.dataset.path || path.startsWith(details.dataset.path + "/")) details.open = true;
  }
}
function renderTree(paths: string[], directories: string[] = []) {
  closeTreeMenu();
  const expanded = new Set(treeProject === meta.project ? [...$("file-tree").querySelectorAll<HTMLElement>("details[open]")].map((d) => d.dataset.path) : []);
  treeProject = meta.project;
  interface FileTree extends Map<string, FileTree | string> {}
  const root: FileTree = new Map();
  for (const path of directories) {
    let node = root;
    for (const part of path.split("/")) {
      if (!node.has(part)) node.set(part, new Map());
      node = node.get(part) as FileTree;
    }
  }
  for (const path of paths) {
    let node = root;
    const parts = path.split("/");
    parts.forEach((part, i) => {
      if (!node.has(part)) node.set(part, i === parts.length - 1 ? path : new Map());
      node = node.get(part) as FileTree;
    });
  }
  function list(node: FileTree, prefix = ""): HTMLUListElement {
    const ul = document.createElement("ul");
    for (const [name, child] of [...node].sort(([a, x], [b, y]) => Number(y instanceof Map) - Number(x instanceof Map) || a.localeCompare(b))) {
      const li = document.createElement("li");
      if (child instanceof Map) {
        const details = document.createElement("details");
        details.dataset.path = prefix + name;
        details.open = expanded.has(details.dataset.path);
        const summary = document.createElement("summary");
        summary.dataset.path = details.dataset.path;
        if (name.startsWith(".")) summary.classList.add("tree-dotfile");
        const folderName = document.createElement("span");
        folderName.append(document.createTextNode(name));
        summary.append(icon(details.open ? "open" : "folder"), folderName);
        if (meta.links?.some((link) => link.path === details.dataset.path)) {
          const label = document.createElement("span");
          label.className = "tree-submodule-label";
          label.textContent = "(submodule)";
          folderName.append(document.createTextNode(" "), label);
        }
        summary.onclick = (event) => {
          if (busy) {
            event.preventDefault();
            return;
          }
          selectedTreePath = summary.dataset.path;
          syncTree();
        };
        summary.onfocus = () => {
          if (busy) return;
          selectedTreePath = summary.dataset.path;
          syncTree();
        };
        details.ontoggle = () => summary.querySelector(".icon").replaceWith(icon(details.open ? "open" : "folder"));
        details.append(summary, list(child, prefix + name + "/"));
        li.append(details);
      } else {
        const b = button(name, () => openFile(child), /\.(tex|bib|sty|cls|txt|md)$/i.test(child) ? "text" : "file", true, { transient: true });
        b.dataset.path = child;
        b.onfocus = () => {
          if (busy) return;
          selectedTreePath = child;
          syncTree();
        };
        if (name.startsWith(".")) b.classList.add("tree-dotfile");
        b.title = child;
        li.append(b);
      }
      ul.append(li);
    }
    return ul;
  }
  $("file-tree").replaceChildren(list(root));
  if (!root.size) $("file-tree").textContent = "No files yet. Create or upload a file.";
  syncTree();
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
  if (file && !paths.includes(file)) {
    file = null;
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
function cancelSync() {
  clearTimeout(syncTimer);
  syncSequence++;
  syncRequest?.abort();
  syncRequest = null;
}
function updateSyncControls() {
  const available = Boolean(syncBuild) && !busyControlsShown;
  $("sync-source-pdf").disabled = !available;
  $("sync-source-pdf").setAttribute("aria-pressed", String(syncActive));
  pdfPreview.setSyncEnabled(available && syncActive);
}
function sourceSyncPosition() {
  const path = editor.getPath();
  return path && path === file && /\.(tex|sty|cls|bib|ltx)$/i.test(path) ? { path, ...editor.getCursor() } : null;
}
function scheduleForwardSync() {
  if (!syncActive || busy) return;
  cancelSync();
  if (!syncBuild || !sourceSyncPosition()) return;
  syncTimer = setTimeout(() => {
    if (editor.hasFocus()) void navigateSync("forward", sourceSyncPosition());
  }, 300);
}
async function navigateSync(direction: "forward" | "backward", position: SourcePosition | { path: string; line: number; column: number }) {
  if (!syncActive || busy || !syncBuild || !position) return;
  cancelSync();
  const sequence = syncSequence;
  const controller = new AbortController();
  syncRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 10000);
  const build = syncBuild;
  const activeRepo = repo;
  const generation = syncGeneration;
  const openGeneration = fileOpenGeneration;
  const current = () => syncActive && sequence === syncSequence && activeRepo === repo && generation === syncGeneration;
  try {
    const response = await fetch("/synctex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ build, direction, ...position }),
      signal: controller.signal,
    });
    const result = await response.json();
    if (busy || !current() || openGeneration !== fileOpenGeneration) return;
    if (!response.ok) {
      if (response.status === 410) {
        syncBuild = null;
      }
      throw new Error(result.error || "Could not navigate between source and PDF.");
    }
    if (direction === "forward") {
      selectOutputTab($("preview-tab"));
      await new Promise(requestAnimationFrame);
      if (busy || !current() || openGeneration !== fileOpenGeneration) return;
      if (!pdfPreview.goToPosition(result)) throw new Error("Mapped PDF page is unavailable");
    } else {
      if (busy || !current() || openGeneration !== fileOpenGeneration) return;
      const path = safePath(result.path);
      await run(
        async () => {
          if (!current() || openGeneration !== fileOpenGeneration) return;
          if (path !== file && (await openFile(path)) === false) return false;
          if (!current() || file !== path) return;
          expandTreePath(path);
          editor.goToLine(result.line, result.column || 1);
        },
        "Opening source",
        true,
        false,
        { completion: false, transient: true },
      );
    }
  } catch (error) {
    if (sequence === syncSequence && activeRepo === repo && generation === syncGeneration && error.name !== "AbortError" && syncError !== error.message) {
      syncError = error.message;
      status(error.message, "error");
    }
  } finally {
    clearTimeout(timeout);
    if (sequence === syncSequence) {
      syncRequest = null;
      updateSyncControls();
    }
  }
}
function updatePdfDownload() {
  $("download-pdf").disabled = busyControlsShown || !builtPdf;
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
let activePdfBuilds = 0;
async function buildDocument(): Promise<OperationResult> {
  const operation = createBuildOperation();
  const previous = { repo, pdf: builtPdf, synctex: syncBuild };
  let rendering = false;
  activePdfBuilds++;
  toastBuildOperation = operation;
  $("publishing").disabled = true;
  $("cancel-build").onclick = () => {
    void operation.cancel().catch(() => {});
    status("Canceling build…", "busy");
  };
  status("Preparing document…", "busy");
  try {
    return await compileDocument(operation, () => {
      rendering = true;
    });
  } catch (error) {
    if (!operation.signal.aborted) throw error;
    try {
      await operation.cancel();
    } catch {
      status("Build canceled locally. Server cancellation could not be confirmed.", "error");
      return { statusHandled: true };
    }
    if (rendering && previous.repo === repo) {
      if (previous.pdf) await preview(previous.pdf, previous.synctex);
      else await pdfPreview.reset();
    }
    status("Build canceled.", "ready");
    return { statusHandled: true };
  } finally {
    if (toastBuildOperation === operation) {
      toastBuildOperation = null;
      $("cancel-build").hidden = true;
      $("cancel-build").onclick = null;
    }
    $("publishing").disabled = --activePdfBuilds > 0;
  }
}
async function compileDocument(operation: ReturnType<typeof createBuildOperation>, onPreviewCommit: () => void): Promise<void | false> {
  const signal = operation.signal;
  await saveDocument();
  signal.throwIfAborted();
  const activeRepo = repo;
  await saving;
  signal.throwIfAborted();
  if (activeRepo !== repo) return;
  const progress = createFileOperationProgress((message) => status(message, "busy"));
  progress({ phase: "preparing" });
  const paths = await activeRepo.files();
  signal.throwIfAborted();
  progress({ phase: "preparing", completed: 0, total: paths.length });
  const snapshot = [];
  const sizes = [];
  for (const path of paths) {
    const bytes = await fs.promises.readFile(`${activeRepo.dir}/${path}`);
    signal.throwIfAborted();
    sizes.push(bytes.byteLength);
    validateSnapshotSizes(sizes, serverConfig.limits);
    snapshot.push({ path, bytes, mode: activeRepo.modes[path] || "100644" });
    progress({ phase: "preparing", completed: snapshot.length, total: paths.length });
  }
  const files = materializeSymlinkFiles(snapshot, serverConfig.limits).map(({ path, bytes }) => ({ path, content: encode64(bytes) }));
  const body = JSON.stringify({ files, buildId: operation.id });
  validateRequestSize(body, serverConfig.limits);
  signal.throwIfAborted();
  progress({ phase: "compiling" });
  const response = await operation.request(body);
  const result = await response.json();
  signal.throwIfAborted();
  if (activeRepo !== repo) return;
  updateLog(result.log || result.error);
  if (!response.ok) {
    if (!builtPdf) selectOutputTab($("logs-tab"));
    throw new Error(result.error || "Compilation failed. See log.");
  }
  progress({ phase: "rendering" });
  const pdf = new Blob([decode64(result.pdf) as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
  await preview(pdf, result.synctex || null, signal);
  onPreviewCommit();
  signal.throwIfAborted();
  builtPdf = pdf;
  updatePdfDownload();
}
async function activate(m: ApplicationWorkspace, { build = true, focus = true } = {}) {
  if (!(await resolveEditorDraft())) return false;
  workspaceReady = false;
  selectSidebarTab($("files-tab"));
  selectOutputTab($("preview-tab"));
  $("workspace-search").value = "";
  workspaceSearch.refresh();
  cancelSync();
  syncActive = true;
  syncError = "";
  syncBuild = null;
  syncGeneration++;
  builtPdf = null;
  updatePdfDownload();
  meta = m;
  if (treeClipboard?.dir !== m.dir) treeClipboard = null;
  repo = new Repository(fs, m.dir, m.links, m.modes);
  changedPaths = new Set();
  file = null;
  resetImagePreview();
  selectedTreePath = null;
  loadEditorDocument();
  editor.setReadOnly(true);
  $("filename").textContent = "No file open";
  updatePageTitle();
  await pdfPreview.reset();
  updateLog("");

  $("target").value = m.branch === mergeRequestTarget() ? "" : m.branch;
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
    if (file !== serverConfig.mainDocument && (await repo.files()).includes(serverConfig.mainDocument)) await openFile(serverConfig.mainDocument);
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
  file = null;
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
  branchSelect.setOptions([...new Set([...branches, ...local.map((m) => m.branch)])]);
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
  const selected = $("branches").value;
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
    branchSelect.setOptions(names);
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
async function openFile(path: string, { source = false } = {}) {
  if (!path) return;
  if (editorDraft.dirty && path === file && editor.getPath() === path) {
    editor.focus();
    return;
  }
  if (!(await resolveEditorDraft())) return false;
  const activeRepo = repo;
  const generation = ++fileOpenGeneration;
  const bytes = await fs.promises.readFile(`${activeRepo.dir}/${path}`);
  if (activeRepo !== repo || generation !== fileOpenGeneration) return;
  imagePreview.reset();
  $("editor").hidden = !source && Boolean(imageType(path));
  file = path;
  selectedTreePath = path;
  updatePageTitle();
  syncTree();
  if (!source && imageType(path)) {
    editor.setReadOnly(true);
    loadEditorDocument();
    updateSyncControls();
    imagePreview.show(bytes as Uint8Array<ArrayBuffer>, path);
    if (workspaceReady) persistActiveDocument();
    return;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) text = null;
  } catch {
    text = null;
  }
  editor.setReadOnly(text === null || !treePathWritable(file));
  loadEditorDocument(text ?? "[Binary file — use download or upload to replace]", text === null ? "" : file);
  updateSyncControls();
  editor.focus();
  if (file.endsWith(".pdf")) await preview(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
  if (workspaceReady) persistActiveDocument();
}
function updateEditorDraft(text: string) {
  editorDraft.update(text);
  if (meta) {
    warningState(meta).draft = editorDraft.dirty;
    showWorkspaceStatus(meta.project);
  }
  updateFilenameSaveState();
  updatePublishingSummary();
  syncTree();
  workspaceSearch.refresh();
}
function loadEditorDocument(text = "", path = "") {
  documentGeneration++;
  editorDraft.load(text);
  if (meta) warningState(meta).draft = false;
  editor.setText(text, path);
  updateFilenameSaveState();
}
async function saveDocument() {
  if (!repo || !file || !editor.canEdit()) return false;
  editor.ensureFinalNewline();
  if (!hasUnsavedDocument()) return false;
  const generation = documentGeneration;
  const activeRepo = repo,
    activeFile = file,
    activeMeta = meta;
  const text = editorDraft.snapshot();
  const state = warningState(activeMeta);
  state.pending++;
  const saveKey = `${activeRepo.dir}/${activeFile}`;
  pendingFileSaves.set(saveKey, (pendingFileSaves.get(saveKey) || 0) + 1);
  updateFilenameSaveState();
  const attempt = saving.then(async () => {
    try {
      await activeRepo.write(activeFile, new TextEncoder().encode(text));
      await fs.promises.flush();
      if (repo === activeRepo && file === activeFile && generation === documentGeneration) editorDraft.saved(text);
      state.errors.delete(activeFile);
      state.errors.delete("[workspace storage]");
      state.draft = editorDraft.dirty;
      markWorkspace(activeMeta);
    } catch (error) {
      state.errors.add(activeFile);
      throw error;
    } finally {
      state.pending--;
      const remaining = pendingFileSaves.get(saveKey) - 1;
      if (remaining) pendingFileSaves.set(saveKey, remaining);
      else pendingFileSaves.delete(saveKey);
      updateFilenameSaveState();
      showWorkspaceStatus(activeMeta.project);
    }
  });
  saving = attempt.catch(() => {});
  await attempt;
  await refresh();
  workspaceSearch.refresh();
  return true;
}
async function discardDocument(confirm = true) {
  if (!hasUnsavedDocument()) return false;
  const failed = Boolean(meta && warningState(meta).errors.size);
  const message = failed
    ? `Reload the stored contents of ${file}? A failed save may already have written some changes; this does not roll back that write.`
    : `Discard unsaved edits to ${file}?`;
  if (
    confirm &&
    !(await confirmDialog(message, {
      title: failed ? "Reload stored file" : "Discard changes",
      icon: "restore",
      confirmLabel: failed ? "Reload" : "Discard",
      destructive: true,
    }))
  )
    return false;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await repo.p.readFile(`${repo.dir}/${file}`));
  if (meta) {
    const state = warningState(meta);
    // A failed flush may have followed a successful write; reload actual contents.
    if (state.errors.size) await fs.promises.flush();
    state.errors.delete(file);
    state.errors.delete("[workspace storage]");
  }
  loadEditorDocument(text, file);
  updateFilenameSaveState();
  await refresh();
  workspaceSearch.refresh();
  return true;
}
async function resolveEditorDraft(saveLabel = "Save", discardLabel = "Discard") {
  if (!file || !hasUnsavedDocument()) return true;
  editor.setBusy(true, !busyControlsShown);
  try {
    const failed = Boolean(meta && warningState(meta).errors.size);
    const message = failed
      ? `Saving ${file} could not be confirmed. Retry Save, or reload the stored file. A failed save may already have written changes.`
      : `Save changes to ${file} before continuing? Unsaved edits are kept only in this tab.`;
    const choice = await saveChangesDialog(message, saveLabel, failed ? "Reload stored file" : discardLabel);
    if (choice === null) return false;
    if (choice === "save") await saveDocument();
    else await discardDocument(false);
    return true;
  } finally {
    editor.setBusy(busy, busy && !busyControlsShown);
  }
}
function mergeRequestTarget() {
  return project?.default_branch?.trim() || undefined;
}
type BranchMergeRequestState = MergeRequestState;
let mergeRequestCheck: { dir: string; token: string; state: BranchMergeRequestState } | null = null;
let mergeRequestCheckSequence = 0;
async function refreshBranchMergeRequest() {
  if (!meta || !project) return;
  const activeMeta = meta;
  const token = $("token").value;
  const sequence = ++mergeRequestCheckSequence;
  mergeRequestCheck = { dir: activeMeta.dir, token, state: "checking" };
  updateMergeRequestControls();
  const current = () => sequence === mergeRequestCheckSequence && meta?.dir === activeMeta.dir && $("token").value === token && $("publishing-dialog").open;
  try {
    const target = await getProjectDefaultBranch(api, project.id);
    if (!current()) return;
    project.default_branch = target;
    const open = await hasOpenMergeRequest(api, project.id, activeMeta.branch);
    if (!current()) return;
    mergeRequestCheck.state = open ? "open" : "none";
  } catch (error) {
    if (!current()) return;
    mergeRequestCheck.state = "error";
    console.warn("Could not check branch merge requests", error);
  }
  updateMergeRequestControls();
}

const publishingSuccess = new Map<string, { committed?: boolean; pushed?: boolean; opened?: boolean }>();
function recordPublishingSuccess(action: "committed" | "pushed" | "opened") {
  if (!meta) return;
  publishingSuccess.set(meta.dir, { ...publishingSuccess.get(meta.dir), [action]: true });
}
function showPublishingSuccess(headingId: string, text: string, visible: boolean) {
  const heading = $(headingId);
  let badge = heading.querySelector<HTMLElement>(".publishing-success");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "publishing-success";
    badge.setAttribute("role", "status");
    badge.append(icon("ready"), document.createTextNode(text));
    heading.append(badge);
  }
  badge.hidden = !visible;
}
const pendingMergeRequests = new Map<string, MergeRequestPublication>();
function pendingMergeRequest(): MergeRequestPublication | undefined {
  const target = mergeRequestTarget();
  if (!meta || !target) return;
  const pending = pendingMergeRequests.get(meta.dir);
  if (pending?.source === meta.branch && pending.target === target) return pending;
  try {
    const value = JSON.parse(localStorage.getItem(`aux-mr:${meta.dir}`) || "null");
    if (value?.source === meta.branch && value.target === target && [value.title, value.commit].every((v) => typeof v === "string" && v)) return value;
  } catch {
    /* Ignore invalid saved publication metadata. */
  }
}
function currentPublishingAvailability() {
  const state = meta && warningState(meta);
  const mergeRequestState = mergeRequestCheck?.dir === meta?.dir && mergeRequestCheck?.token === $("token").value ? mergeRequestCheck.state : "checking";
  return publishingAvailability({
    branch: meta?.branch,
    targetBranch: mergeRequestTarget(),
    commitsKnown: Boolean(state?.known),
    unpublished: Boolean(state?.unpublished),
    mergeRequestState,
  });
}
function updateCommitControls() {
  const state = meta && warningState(meta);
  const disabled = !meta || Boolean(state?.dirtyKnown && !state.dirty);
  $("commit-options").setAttribute("aria-disabled", String(disabled));
  $<HTMLButtonElement>("commit").disabled = busy || disabled;
  $<HTMLInputElement>("message").disabled = busy || disabled;
  $("commit-description").textContent = disabled ? "No saved changes to commit." : "Record saved changes in this browser before publishing.";
  showPublishingSuccess(
    "commit-heading",
    "Done",
    Boolean(meta && publishingSuccess.get(meta.dir)?.committed && state?.dirtyKnown && !state.dirty && !state.draft),
  );
}
function updatePushControls() {
  const { pushDisabled } = currentPublishingAvailability();
  $("push-options").setAttribute("aria-disabled", String(pushDisabled));
  const state = meta && warningState(meta);
  showPublishingSuccess(
    "push-heading",
    "Done",
    Boolean(meta && publishingSuccess.get(meta.dir)?.pushed && state?.known && !state.unpublished && !state.dirty && !state.draft),
  );
  $<HTMLButtonElement>("push").disabled = busy || pushDisabled;
  $("target").disabled = busy || pushDisabled;
  updateTargetBranches();
  $("publish-description").textContent =
    pushDisabled && meta && warningState(meta).known
      ? "No commits to push."
      : "Choose a remote branch or enter a new branch name. New branches are created when you push.";
}
function updateMergeRequestControls() {
  updateCommitControls();
  const pending = pendingMergeRequest();
  const { mergeRequestDisabled, mergeRequestChecking } = currentPublishingAvailability();

  $("merge-request-options").hidden = false;
  $("create-mr").replaceChildren(icon("branch"), document.createTextNode(pending ? "Retry" : "Open merge request"));
  $("merge-request-options").setAttribute("aria-disabled", String(mergeRequestDisabled));
  const requestOpen = mergeRequestCheck?.dir === meta?.dir && mergeRequestCheck?.token === $("token").value && mergeRequestCheck.state === "open";
  showPublishingSuccess("mr-heading", "Done", Boolean(requestOpen && publishingSuccess.get(meta.dir)?.opened));

  $<HTMLButtonElement>("create-mr").disabled = busy || mergeRequestDisabled || mergeRequestChecking;
  $("mr-title").disabled = busy || mergeRequestDisabled || mergeRequestChecking;
  $("mr-help").textContent = requestOpen
    ? "A merge request is already open for this branch."
    : !mergeRequestTarget()
      ? "The project’s default branch is unavailable. Refresh documents and try again."
      : meta?.branch === mergeRequestTarget()
        ? "The active branch is this project’s default branch."
        : pending
          ? "Retry creating the merge request. Commits will not be pushed again."
          : "The merge request will be based on the currently active branch.";
  updatePushControls();
  $("push").replaceChildren(icon("push"), document.createTextNode("Push commits"));
}
async function switchToPublishedBranch(branch: string) {
  const previousBranch = meta.branch;
  const previousFile = file;
  const branches = [...$("branches").options].map((option) => option.value);
  branchSelect.setOptions([...new Set([...branches, branch])]);
  branchSelect.setValue(branch);
  try {
    const result = await pull(false, { build: false });
    if (result === false || meta?.branch !== branch || !workspaceReady) throw new Error("Could not open the published branch.");
    if (previousFile && previousFile !== file && (await repo.files()).includes(previousFile)) await openFile(previousFile);
    await refresh();
  } catch (error) {
    if (meta?.branch === previousBranch) branchSelect.setValue(previousBranch);
    throw error;
  }
}
async function showPublishedBranch(branch: string, previousBranch: string, createdMergeRequest?: MergeRequestResult) {
  const switchBranch = meta.branch !== branch;
  let switchError = "";
  try {
    if (switchBranch) await switchToPublishedBranch(branch);
    else await refresh();
  } catch (error) {
    switchError = error.message || String(error);
  }
  let request = createdMergeRequest;
  let lookupFailed = false;
  if (!request) {
    try {
      request = await findOpenMergeRequest(api, project.id, branch);
    } catch (error) {
      lookupFailed = true;
      console.warn("Published successfully, but could not retrieve the merge request", error);
    }
  }
  const projectURL = `${serverConfig.gitlabUrl}/${project.path_with_namespace.split("/").map(encodeURIComponent).join("/")}`;
  const createQuery = new URLSearchParams({ "merge_request[source_branch]": branch });
  const defaultBranch = mergeRequestTarget();
  if (defaultBranch) createQuery.set("merge_request[target_branch]", defaultBranch);
  const links = request
    ? [{ label: `View merge request !${request.iid}`, href: request.web_url }]
    : lookupFailed
      ? [{ label: "View merge requests", href: `${projectURL}/-/merge_requests?${new URLSearchParams({ state: "opened", source_branch: branch })}` }]
      : [{ label: "Create merge request on GitLab", href: `${projectURL}/-/merge_requests/new?${createQuery}` }];
  if (!switchError) {
    mergeRequestCheckSequence++;
    mergeRequestCheck = { dir: meta.dir, token: $("token").value, state: request ? "open" : lookupFailed ? "error" : "none" };
    updateMergeRequestControls();
  }
  const published = createdMergeRequest ? `Merge request !${createdMergeRequest.iid} is open for branch ${branch}.` : `Published to ${branch}.`;
  const message = switchError
    ? `${published} Could not switch automatically: ${switchError}\n\nYour local work has been kept.`
    : switchBranch
      ? `${published} You’re now editing that branch. Your ${previousBranch} workspace is still saved in this browser.`
      : published;
  status(switchError ? message : published, switchError ? "error" : "ready");
  await alertDialog(message, { title: "Published", icon: switchError ? "warning" : "ready", links });
  return !switchError;
}
async function publishMergeRequest() {
  if (!meta || !project) throw new Error("Open a project before creating a merge request.");
  const target = await getProjectDefaultBranch(api, project.id);
  project.default_branch = target;
  updateMergeRequestControls();
  if (meta.branch === target) throw new Error(`Open a merge request from a working branch, not the default branch (${target}).`);
  if (!(await resolveEditorDraft())) return false;

  let pending = pendingMergeRequest();
  if (!pending) {
    const source = meta.branch;
    if ((await repo.changes()).length) throw new Error("Commit all working changes before creating a merge request.");
    await api.request<RemoteBranch>(`projects/${encodeURIComponent(project.id)}/repository/branches/${encodeURIComponent(target)}`);
    const unpublished = (await repo.head()) !== meta.base;
    const logs = await repo.history();
    const latest = logs.find((entry) => !/^Pull [^\r\n]+ @ [0-9a-f]{40}\s*$/i.test(entry.commit.message));
    const title = $("mr-title").value.trim() || latest?.commit.message.trim().split(/\r?\n/)[0] || `Merge ${source} into ${target}`;

    if (unpublished && (await push({ branch: source })) === false) return false;
    pending = { source, target, title, commit: meta.remote };
    // Save before the MR POST so a failed/lost response can be retried without republishing.
    pendingMergeRequests.set(meta.dir, pending);
    try {
      localStorage.setItem(`aux-mr:${meta.dir}`, JSON.stringify(pending));
    } catch {
      console.warn("MR retry state could not be saved; keep this tab open to retry.");
    }
  }
  pending.title = $("mr-title").value.trim() || pending.title;
  pendingMergeRequests.set(meta.dir, pending);
  try {
    localStorage.setItem(`aux-mr:${meta.dir}`, JSON.stringify(pending));
  } catch {
    /* In-memory retry remains available. */
  }
  let result: MergeRequestResult;
  try {
    result = await createMergeRequest(api, project.id, pending);
  } catch (error) {
    throw new Error(`Changes are published to ${pending.source}, but merge request creation failed. Retry here without pushing again. ${error.message}`);
  }
  recordPublishingSuccess("opened");
  const previousBranch = meta.branch;
  pendingMergeRequests.delete(meta.dir);
  try {
    localStorage.removeItem(`aux-mr:${meta.dir}`);
  } catch {
    /* An existing MR is detected on retry. */
  }
  const completed = await showPublishedBranch(pending.source, previousBranch, result);
  if (completed) $("publishing-dialog").close();
  return { statusHandled: true };
}
async function push({ branch }: { branch?: string } = {}): Promise<OperationResult> {
  if (!(await resolveEditorDraft())) return false;
  if ((await repo.changes()).length) throw new Error("Commit all working changes before pushing.");
  const target = branch || $("target").value.trim();
  if (!target) throw new Error("Choose a target branch.");
  const base = await repo.snapshot(meta.base),
    current = await repo.snapshot(await repo.head());
  for (const [path, mode] of Object.entries(meta.modes)) {
    if (base[path]) base[path].mode = mode;
    if (current[path]) current[path].mode = mode;
  }
  const actions: (ReturnType<typeof changedActions>[number] & { last_commit_id?: string })[] = changedActions(base, current);
  if (!actions.length) throw new Error("No committed differences to push.");
  if (
    (target === "main" || target === "master") &&
    !(await confirmDialog(`Push directly to ${target}? These changes will update the branch without a merge request.`, {
      title: `Push to ${target}?`,
      icon: "warning",
      confirmLabel: `Push to ${target}`,
      destructive: true,
    }))
  )
    return false;
  status("Pushing commits…", "busy");
  let remote: RemoteBranch;
  try {
    remote = await api.request<RemoteBranch>(`projects/${project.id}/repository/branches/${encodeURIComponent(target)}`);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  if (remote && remote.commit.id !== meta.remote)
    throw new Error("Target differs from the pulled baseline. Push to a new branch, or reconcile in GitLab. No force push performed.");
  const localHead = await repo.head();
  const logs = await repo.history();
  const message = $("message").value.trim() || logs[0].commit.message;
  const author = { name: $("author").value.trim(), email: $("email").value.trim() };
  let result: { id: string };
  if (!remote) {
    // Reserve the branch first so file guards use it, rather than GitLab's default branch.
    result = {
      id: await publishMergeRequestBranch(api, project.id, target, meta.branch, meta.remote, message, author, actions),
    };
  } else {
    // Keep file-level guards when updating an existing branch.
    for (const action of actions.filter((a) => a.action === "update" || a.action === "delete")) {
      const f = await api.request<{ last_commit_id: string }>(
        `projects/${project.id}/repository/files/${encodeURIComponent(action.file_path)}?ref=${meta.remote}`,
      );
      action.last_commit_id = f.last_commit_id;
    }
    result = await api.request<{ id: string }>(`projects/${project.id}/repository/commits`, {
      branch: target,
      commit_message: message,
      author_name: author.name,
      author_email: author.email,
      actions,
    });
  }
  const next = {
    ...meta,
    publication: { localHead, branch: target, remoteCommit: result.id },
    ...(target === meta.branch ? { base: localHead, remote: result.id } : {}),
  };
  const published = { ...workspaces, [`${meta.project}:${meta.branch}`]: next };
  try {
    persist(published);
  } catch (error) {
    throw new Error(
      `Commits were pushed to ${target}, but saving their local publication status failed. Do not push again without checking GitLab. ${error.message}`,
    );
  }
  workspaces = published;
  meta = next;
  if (target !== meta.branch) {
    const previousBranch = meta.branch;
    status(`Commits pushed to ${target}.`, "ready");
    const switchBranch = await confirmDialog(
      `Your commits were successfully pushed to ${target}.\n\nSwitch to ${target} to continue editing the branch with your changes?`,
      { title: "Commits pushed", icon: "ready", confirmLabel: "Switch branch", confirmIcon: "branch", cancelLabel: "Stay on current branch" },
    );
    if (!switchBranch) {
      status(`Commits pushed to ${target}. You’re still editing ${previousBranch}.`, "ready");
      return { statusHandled: true };
    }
    const committed = publishingSuccess.get(meta.dir)?.committed;
    const switched = await showPublishedBranch(target, previousBranch);
    if (switched && meta.branch === target) {
      if (committed) recordPublishingSuccess("committed");
      recordPublishingSuccess("pushed");
      updateCommitControls();
      updatePushControls();
    }
    return { statusHandled: true };
  } else {
    markWorkspace();
    recordPublishingSuccess("pushed");
  }
  await refresh();
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

$("sync-source-pdf").onclick = () => {
  if (busy || !syncBuild) return;
  cancelSync();
  syncActive = !syncActive;
  syncError = "";
  updateSyncControls();
  if (syncActive) void navigateSync("forward", sourceSyncPosition());
};
async function preview(blob: Blob, build: string = null, signal?: AbortSignal) {
  signal?.throwIfAborted();
  cancelSync();
  syncError = "";
  const generation = ++syncGeneration;
  const previousSyncBuild = syncBuild;
  syncBuild = null;
  updateSyncControls();
  selectOutputTab($("preview-tab"));
  const abort = () => {
    if (generation !== syncGeneration) return;
    syncGeneration++;
    cancelSync();
    syncBuild = previousSyncBuild;
    updateSyncControls();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await pdfPreview.show(blob, signal);
    signal?.throwIfAborted();
    if (generation !== syncGeneration) return;
    syncBuild = build;
    updateSyncControls();
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
function goDocuments() {
  if (busy) return;
  if (currentNavigation.view === "editor") history.back();
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
      if ((file === path || file?.startsWith(path + "/")) && !(await resolveEditorDraft())) return false;
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
async function saveCustomRepositories() {
  const input = $<HTMLTextAreaElement>("custom-repositories");
  const feedback = $("custom-repositories-status");
  let paths: string[];
  try {
    paths = parseCustomRepositories(input.value, serverConfig.gitlabUrl);
  } catch (error) {
    input.setAttribute("aria-invalid", "true");
    feedback.textContent = error.message;
    throw error;
  }
  input.removeAttribute("aria-invalid");
  input.value = paths.join("\n");
  if (JSON.stringify(paths) === JSON.stringify(customRepositories)) return;
  const next = { ...settings, customRepositories: paths };
  try {
    localStorage.setItem("aux-settings", JSON.stringify(next));
  } catch {
    feedback.textContent = "Could not save repositories in this browser. Try again.";
    throw new Error(feedback.textContent);
  }
  settings = next;
  customRepositories = paths;
  feedback.textContent = "Saved. Refreshing documents…";
  renderCatalog();
  try {
    await refreshDocuments();
    feedback.textContent = "Saved. Documents refreshed.";
  } catch (error) {
    feedback.textContent = `List saved. ${error.message}`;
    throw error;
  }
}
function refreshDocuments({ background = false } = {}) {
  const refresh = $("repositories");
  refresh.setAttribute("aria-busy", "true");
  refresh.dataset.loading = "true";
  const generation = ++catalogGeneration;
  setDashboardRefreshing(true);
  const token = $("token").value;
  const current = () => generation === catalogGeneration && token === $("token").value;
  let progressVersion: number;
  const pending = (async () => {
    const [groupProjects, customResults] = await Promise.all([
      fetchGroupRepositories<ApplicationProject>((endpoint) => api.pages<ApplicationProject>(endpoint), serverConfig.repositoryGroups),
      Promise.allSettled(
        customRepositories.map((path) =>
          fetchCustomRepositories<ApplicationProject>(
            (endpoint) => api.request(endpoint),
            [path],
            (endpoint) => api.pages<ApplicationProject>(endpoint),
          ).catch((error) => {
            throw new Error(`${path}: ${error.message}`);
          }),
        ),
      ),
    ]);
    if (!current()) return;
    const projects = [...groupProjects, ...customResults.flatMap((result) => (result.status === "fulfilled" ? result.value : []))];
    const customErrors = customResults.flatMap((result) => (result.status === "rejected" ? [result.reason.message] : []));
    const cachedTags = new Map(catalog.map((p) => [String(p.id), p.latestTag]));
    catalog = groupCatalogRepositories(projects.filter(isAvailableProject), serverConfig.repositoryGroups, customRepositories)
      .flatMap(({ projects }) => projects)
      .map((p) => {
        const latestTag = cachedTags.get(String(p.id));
        return typeof latestTag === "string" || latestTag === null ? { ...p, latestTag } : p;
      });
    localStorage.setItem("aux-projects", JSON.stringify(catalog));
    lastRepositoriesRefresh = Date.now();
    localStorage.setItem("aux-last-repositories-refresh", String(lastRepositoriesRefresh));
    updateRepositoryTimes();
    renderCatalog();
    await fetchCatalogTags(
      generation,
      background
        ? undefined
        : (done, total) => {
            if (!current()) return;
            status(`Retrieving version tags: ${done}/${total}…`, "busy");
            progressVersion = statusVersion;
          },
      {
        refreshAll: !background,
      },
    );
    if (customErrors.length)
      throw new Error(`Could not load additional repositories: ${customErrors.join("; ")}. Check the paths and token access in Settings.`);
  })();
  documentsRefresh = pending;
  return pending.finally(() => {
    if (progressVersion !== undefined && progressVersion === statusVersion) dismissStatus();
    if (documentsRefresh === pending) {
      documentsRefresh = null;
      setDashboardRefreshing(false);
      refresh.setAttribute("aria-busy", "false");
      delete refresh.dataset.loading;
    }
  });
}
for (const [id, action] of Object.entries({
  repositories: () => refreshDocuments(),
  "refresh-branches": refreshRemoteBranches,
  pull: () => pull(),
  "force-pull": () => pull(true),

  ...getFileActions(),
  "discard-file": () => discardDocument(),
  commit: async (): Promise<void | false> => {
    if (!(await resolveEditorDraft())) return false;
    const message = $("message").value.trim(),
      name = $("author").value.trim(),
      email = $("email").value.trim();
    if (!message || !name || !email) throw new Error("Enter commit message, author and email.");
    if (!(await repo.changes()).length) throw new Error("Nothing to commit.");
    markWorkspace();
    await repo.commit(message, { name, email });
    recordPublishingSuccess("committed");
    await refresh();
  },
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
    if (id in getFileActions()) return invokeFileAction(id, label);
    return run(action, label, false, id === "repositories", { initialProgress: id !== "force-pull" && id !== "push", transient: id === "discard-file" });
  };
}
installShortcuts({
  ready: () => workspaceReady && !$("workspace").hidden,
  saveAndBuild: () => {
    if (!busy) $("compile").click();
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
async function uploadFiles(files: File[], destination: string, relativePath: (source: File) => string = (source) => source.name) {
  if (!workspaceReady || !repo) throw new Error("Open a workspace before uploading files.");
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
      const choice = remainingAction ? { action: remainingAction, applyToRemaining: true } : await uploadConflictDialog(path);
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
  validateSnapshotSizes(sizes.values(), serverConfig.limits);
  if (planned.some((item) => item.path === file) && !(await resolveEditorDraft())) return false;
  let uploaded = false;
  let replacedOpenFile = false;
  try {
    for (const { source, path } of planned) {
      const bytes = new Uint8Array(await source.arrayBuffer());
      markWorkspace();
      await repo.write(path, bytes);
      uploaded = true;
      replacedOpenFile ||= path === file;
    }
  } finally {
    if (uploaded) {
      const selection = selectedTreePath;
      await refresh();
      if (replacedOpenFile) await openFile(file);
      selectedTreePath = selection;
      if (destination) expandTreePath(destination);
      syncTree();
    }
  }
  return uploaded;
}
for (const id of ["uploads", "folder-uploads"]) {
  $(id).onchange = () => {
    const files = [...$<HTMLInputElement>(id).files];
    const destination = creationDirectory();
    $<HTMLInputElement>(id).value = "";
    const relativePath = id === "folder-uploads" ? (source: File) => source.webkitRelativePath : (source: File) => source.name;
    if (files.length) void run(() => uploadFiles(files, destination, relativePath), "Uploading files");
  };
}
const fileTree = $("file-tree");
const dropOverlay = document.createElement("div");
dropOverlay.className = "file-drop-overlay";
dropOverlay.setAttribute("role", "status");
dropOverlay.setAttribute("aria-live", "polite");
dropOverlay.hidden = true;
$("files-panel").append(dropOverlay);
let fileDragDepth = 0;
function externalFiles(event: DragEvent) {
  return [...(event.dataTransfer?.types || [])].includes("Files");
}
function dropDirectory(event: DragEvent) {
  const folder = (event.target as HTMLElement).closest?.("summary[data-path]") as HTMLElement;
  return folder && fileTree.contains(folder) ? folder.dataset.path : creationDirectory();
}
function clearFileDrop() {
  fileDragDepth = 0;
  dropOverlay.hidden = true;
  dropOverlay.textContent = "";
  for (const row of fileTree.querySelectorAll<HTMLElement>(".tree-drop-target")) row.classList.remove("tree-drop-target");
}
function showFileDrop(event: DragEvent) {
  if (busy || !workspaceReady || $("workspace").hidden) {
    clearFileDrop();
    event.dataTransfer.dropEffect = "none";
    return;
  }
  const destination = dropDirectory(event);
  const writable = !destination || treePathWritable(destination);
  event.dataTransfer.dropEffect = writable ? "copy" : "none";
  const message = writable ? `Drop files into ${destination || "the repository root"}` : "This folder is read-only";
  if (dropOverlay.textContent !== message) {
    const label = document.createElement("span");
    label.textContent = message;
    dropOverlay.replaceChildren(icon(writable ? "upload" : "error"), label);
  }
  dropOverlay.hidden = false;
  for (const row of fileTree.querySelectorAll<HTMLElement>("summary[data-path]")) {
    row.classList.toggle("tree-drop-target", row.dataset.path === destination);
  }
}
fileTree.addEventListener("dragenter", (event) => {
  if (!externalFiles(event)) return;
  event.preventDefault();
  fileDragDepth++;
  showFileDrop(event);
});
fileTree.addEventListener("dragover", (event) => {
  if (!externalFiles(event)) return;
  event.preventDefault();
  showFileDrop(event);
});
fileTree.addEventListener("dragleave", (event) => {
  if (!externalFiles(event)) return;
  if (--fileDragDepth <= 0) clearFileDrop();
});
fileTree.addEventListener("drop", (event) => {
  if (!externalFiles(event)) return;
  event.preventDefault();
  const destination = dropDirectory(event);
  const files = [...event.dataTransfer.files];
  const directory = [...event.dataTransfer.items].some((item) => item.webkitGetAsEntry?.()?.isDirectory);
  clearFileDrop();
  if (busy || !workspaceReady || $("workspace").hidden) return;
  void run(() => {
    if (directory) throw new Error("Use Upload folder in the file toolbar to upload a folder.");
    return files.length ? uploadFiles(files, destination) : false;
  }, "Uploading files");
});
for (const type of ["dragover", "drop"] as const) {
  document.addEventListener(type, (event) => {
    if (!externalFiles(event)) return;
    event.preventDefault();
    if (type === "drop" || !fileTree.contains(event.target as Node)) {
      clearFileDrop();
      event.dataTransfer.dropEffect = "none";
    }
  });
}
window.addEventListener("blur", clearFileDrop);
document.addEventListener("dragend", clearFileDrop);
catalogView.installFilterControls();
renderCatalog();
if (setupComplete() && readStorage("aux-setup-complete") !== "false" && !documentsRefresh) {
  void refreshDocuments({ background: true }).catch((error) => console.warn("Could not refresh document metadata; showing cached documents", error));
}
// Sequential checks avoid flooding browser storage when many branches are cached.
void (async () => {
  for (const m of Object.values(workspaces)) await refreshWarning(m);
})();

async function restoreActiveDocument() {
  const m =
    startupDocument &&
    Object.values(workspaces).find(
      (entry) =>
        String(entry.project) === String(startupDocument.projectId) &&
        entry.branch === startupDocument.branch &&
        (!initialNavigation?.dir || entry.dir === initialNavigation.dir),
    );
  const cachedProject =
    m &&
    [initialNavigation?.project, ...catalog].find((entry) => entry && String(entry.id) === String(m.project) && typeof entry.path_with_namespace === "string");
  let available = false;
  if (m && cachedProject) {
    try {
      await fs.promises.stat(`${m.dir}/.git`);
      available = true;
    } catch {
      // A metadata entry alone is not a cached repository.
    }
  }
  if (!available) {
    showView(false, { focus: false });
    return;
  }
  restoringDocument = true;
  try {
    treeProject = null;
    project = cachedProject;
    branchSelect.setOptions([
      ...new Set(
        Object.values(workspaces)
          .filter((entry) => String(entry.project) === String(project.id))
          .map((entry) => entry.branch),
      ),
    ]);
    selectSidebarTab($("files-tab"));
    const result = await activate(m, { focus: false });
    if (startupDocument.filePath && startupDocument.filePath !== file && (await repo.files()).includes(startupDocument.filePath)) {
      await openFile(startupDocument.filePath);
    }

    return result;
  } catch (error) {
    console.warn("Could not restore cached document", error);
    showView(false, { focus: false });
  } finally {
    restoringDocument = false;
    persistActiveDocument();
  }
}
void (async () => {
  if (!setupComplete() || readStorage("aux-setup-complete") === "false") await openSetup();
  document.body.classList.remove("setup-pending");
  await run(restoreActiveDocument, "Restoring document", false, false, { completion: false });
})();
