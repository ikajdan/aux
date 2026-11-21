// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EditorDraft } from "./editor-draft.js";
import { imageType } from "../image-preview.js";
import type { createImagePreview } from "../image-preview.js";
import type { createEditor } from "../latex-editor.js";
import type { Repository } from "../git-repository.js";
import type { ApplicationWorkspace, ProjectId, WorkspaceWarning } from "../application-types.js";
import type { confirmDialog, saveChangesDialog } from "../modal-dialogs.js";

export interface EditorDocumentDependencies {
  editor: Pick<ReturnType<typeof createEditor>, "getPath" | "focus" | "setReadOnly" | "setText" | "canEdit" | "ensureFinalNewline" | "setBusy">;
  imagePreview: Pick<ReturnType<typeof createImagePreview>, "reset" | "show">;
  fs: { promises: { readFile(path: string): Promise<Uint8Array>; flush(): Promise<unknown> } };
  getWorkspace(): { repo: Pick<Repository, "dir" | "write" | "p">; meta: ApplicationWorkspace };
  workspaceWarnings: Map<string, WorkspaceWarning>;
  warningState(meta: ApplicationWorkspace): WorkspaceWarning;
  elements: { editor: HTMLElement; filename: HTMLElement; readOnly: HTMLElement; discard: HTMLButtonElement };
  isBusy(): boolean;
  areBusyControlsShown(): boolean;
  isWorkspaceReady(): boolean;
  setSelectedTreePath(path: string): void;
  updatePageTitle(): void;
  syncTree(): void;
  updateSyncControls(): void;
  persistActiveDocument(): void;
  treePathWritable(path: string): boolean;
  preview(pdf: Blob): Promise<unknown>;
  showWorkspaceStatus(project: ProjectId): void;
  updatePublishingSummary(): void;
  refreshSearch(): void;
  markWorkspace(meta: ApplicationWorkspace): void;
  refresh(): Promise<unknown>;
  confirmDialog: typeof confirmDialog;
  saveChangesDialog: typeof saveChangesDialog;
}

export function createEditorDocument(d: EditorDocumentDependencies) {
  const { editor, imagePreview, fs, workspaceWarnings } = d;
  const editorDraft = new EditorDraft();
  let file: string;
  let documentGeneration = 0;
  let fileOpenGeneration = 0;
  let saving: Promise<void> = Promise.resolve();
  const pendingFileSaves = new Map<string, number>();
  function resetImagePreview() {
    fileOpenGeneration++;
    imagePreview.reset();
    d.elements.editor.hidden = false;
  }
  function hasUnsavedDocument() {
    return editorDraft.dirty || Boolean(file && workspaceWarnings.get(d.getWorkspace().meta?.dir)?.errors.has(file));
  }
  function updateFilenameSaveState() {
    const key = d.getWorkspace().repo && file ? `${d.getWorkspace().repo.dir}/${file}` : "";
    const unsaved = Boolean(editorDraft.dirty || (key && (pendingFileSaves.has(key) || workspaceWarnings.get(d.getWorkspace().meta?.dir)?.errors.has(file))));
    d.elements.filename.classList.toggle("unsaved", unsaved);
    d.elements.readOnly.hidden = !file || editor.canEdit();
    d.elements.discard.closest<HTMLElement>(".editor-save-actions").hidden = !editor.canEdit();
    d.elements.discard.disabled = d.isBusy() || !file || !hasUnsavedDocument();
  }
  async function openFile(path: string, { source = false } = {}) {
    if (!path) return;
    if (editorDraft.dirty && path === file && editor.getPath() === path) {
      editor.focus();
      return;
    }
    if (!(await resolveEditorDraft())) return false;
    const activeRepo = d.getWorkspace().repo;
    const generation = ++fileOpenGeneration;
    const bytes = await fs.promises.readFile(`${activeRepo.dir}/${path}`);
    if (activeRepo !== d.getWorkspace().repo || generation !== fileOpenGeneration) return;
    imagePreview.reset();
    d.elements.editor.hidden = !source && Boolean(imageType(path));
    file = path;
    d.setSelectedTreePath(path);
    d.updatePageTitle();
    d.syncTree();
    if (!source && imageType(path)) {
      editor.setReadOnly(true);
      loadEditorDocument();
      d.updateSyncControls();
      imagePreview.show(bytes as Uint8Array<ArrayBuffer>, path);
      if (d.isWorkspaceReady()) d.persistActiveDocument();
      return;
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0")) text = null;
    } catch {
      text = null;
    }
    editor.setReadOnly(text === null || !d.treePathWritable(file));
    loadEditorDocument(text ?? "[Binary file — use download or upload to replace]", text === null ? "" : file);
    d.updateSyncControls();
    editor.focus();
    if (file.endsWith(".pdf")) await d.preview(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
    if (d.isWorkspaceReady()) d.persistActiveDocument();
  }
  function updateEditorDraft(text: string) {
    editorDraft.update(text);
    if (d.getWorkspace().meta) {
      d.warningState(d.getWorkspace().meta).draft = editorDraft.dirty;
      d.showWorkspaceStatus(d.getWorkspace().meta.project);
    }
    updateFilenameSaveState();
    d.updatePublishingSummary();
    d.syncTree();
    d.refreshSearch();
  }
  function loadEditorDocument(text = "", path = "") {
    documentGeneration++;
    editorDraft.load(text);
    if (d.getWorkspace().meta) d.warningState(d.getWorkspace().meta).draft = false;
    editor.setText(text, path);
    updateFilenameSaveState();
  }
  async function saveDocument() {
    if (!d.getWorkspace().repo || !file || !editor.canEdit()) return false;
    editor.ensureFinalNewline();
    if (!hasUnsavedDocument()) return false;
    const generation = documentGeneration;
    const activeRepo = d.getWorkspace().repo,
      activeFile = file,
      activeMeta = d.getWorkspace().meta;
    const text = editorDraft.snapshot();
    const state = d.warningState(activeMeta);
    state.pending++;
    const saveKey = `${activeRepo.dir}/${activeFile}`;
    pendingFileSaves.set(saveKey, (pendingFileSaves.get(saveKey) || 0) + 1);
    updateFilenameSaveState();
    const attempt = saving.then(async () => {
      try {
        await activeRepo.write(activeFile, new TextEncoder().encode(text));
        await fs.promises.flush();
        if (d.getWorkspace().repo === activeRepo && file === activeFile && generation === documentGeneration) editorDraft.saved(text);
        state.errors.delete(activeFile);
        state.errors.delete("[workspace storage]");
        state.draft = editorDraft.dirty;
        d.markWorkspace(activeMeta);
      } catch (error) {
        state.errors.add(activeFile);
        throw error;
      } finally {
        state.pending--;
        const remaining = pendingFileSaves.get(saveKey) - 1;
        if (remaining) pendingFileSaves.set(saveKey, remaining);
        else pendingFileSaves.delete(saveKey);
        updateFilenameSaveState();
        d.showWorkspaceStatus(activeMeta.project);
      }
    });
    saving = attempt.catch(() => {});
    await attempt;
    await d.refresh();
    d.refreshSearch();
    return true;
  }
  async function discardDocument(confirm = true) {
    if (!hasUnsavedDocument()) return false;
    const failed = Boolean(d.getWorkspace().meta && d.warningState(d.getWorkspace().meta).errors.size);
    const message = failed
      ? `Reload the stored contents of ${file}? A failed save may already have written some changes; this does not roll back that write.`
      : `Discard unsaved edits to ${file}?`;
    if (
      confirm &&
      !(await d.confirmDialog(message, {
        title: failed ? "Reload stored file" : "Discard changes",
        icon: "restore",
        confirmLabel: failed ? "Reload" : "Discard",
        destructive: true,
      }))
    )
      return false;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await d.getWorkspace().repo.p.readFile(`${d.getWorkspace().repo.dir}/${file}`));
    if (d.getWorkspace().meta) {
      const state = d.warningState(d.getWorkspace().meta);
      // A failed flush may have followed a successful write; reload actual contents.
      if (state.errors.size) await fs.promises.flush();
      state.errors.delete(file);
      state.errors.delete("[workspace storage]");
    }
    loadEditorDocument(text, file);
    updateFilenameSaveState();
    await d.refresh();
    d.refreshSearch();
    return true;
  }
  async function resolveEditorDraft(saveLabel = "Save", discardLabel = "Discard") {
    if (!file || !hasUnsavedDocument()) return true;
    editor.setBusy(true, !d.areBusyControlsShown());
    try {
      const failed = Boolean(d.getWorkspace().meta && d.warningState(d.getWorkspace().meta).errors.size);
      const message = failed
        ? `Saving ${file} could not be confirmed. Retry Save, or reload the stored file. A failed save may already have written changes.`
        : `Save changes to ${file} before continuing? Unsaved edits are kept only in this tab.`;
      const choice = await d.saveChangesDialog(message, saveLabel, failed ? "Reload stored file" : discardLabel);
      if (choice === null) return false;
      if (choice === "save") await saveDocument();
      else await discardDocument(false);
      return true;
    } finally {
      editor.setBusy(d.isBusy(), d.isBusy() && !d.areBusyControlsShown());
    }
  }

  return {
    get path() { return file; },
    // Path assignments alone never invalidated document or open generations.
    set path(path: string) { file = path; },
    get saving() { return saving; },
    get dirty() { return editorDraft.dirty; },
    get openGeneration() { return fileOpenGeneration; },
    openFile, updateEditorDraft, loadEditorDocument, saveDocument, discardDocument,
    resolveEditorDraft, hasUnsavedDocument, updateFilenameSaveState, resetImagePreview,
  };
}
