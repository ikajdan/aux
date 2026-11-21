// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { icon } from "../ui-icons.js";

export interface FileUploadUIDependencies {
  tree: HTMLElement;
  panel: HTMLElement;
  filesInput: HTMLInputElement;
  folderInput: HTMLInputElement;
  ready(): boolean;
  creationDirectory(): string;
  pathWritable(path: string): boolean;
  upload(files: File[], destination: string, relativePath?: (source: File) => string, directory?: boolean): unknown;
}

export function installFileUploadUI(deps: FileUploadUIDependencies): void {
  const { tree: fileTree, panel, filesInput, folderInput } = deps;
  for (const input of [filesInput, folderInput]) {
    input.onchange = () => {
      const files = [...input.files];
      const destination = deps.creationDirectory();
      input.value = "";
      const relativePath = input === folderInput ? (source: File) => source.webkitRelativePath : (source: File) => source.name;
      if (files.length) void deps.upload(files, destination, relativePath);
    };
  }
  const dropOverlay = document.createElement("div");
  dropOverlay.className = "file-drop-overlay";
  dropOverlay.setAttribute("role", "status");
  dropOverlay.setAttribute("aria-live", "polite");
  dropOverlay.hidden = true;
  panel.append(dropOverlay);
  let fileDragDepth = 0;
  function externalFiles(event: DragEvent) {
    return [...(event.dataTransfer?.types || [])].includes("Files");
  }
  function dropDirectory(event: DragEvent) {
    const folder = event.target instanceof Element ? event.target.closest<HTMLElement>("summary[data-path]") : null;
    return folder && fileTree.contains(folder) ? folder.dataset.path : deps.creationDirectory();
  }
  function clearFileDrop() {
    fileDragDepth = 0;
    dropOverlay.hidden = true;
    dropOverlay.textContent = "";
    for (const row of fileTree.querySelectorAll<HTMLElement>(".tree-drop-target")) row.classList.remove("tree-drop-target");
  }
  function showFileDrop(event: DragEvent) {
    if (!deps.ready()) {
      clearFileDrop();
      event.dataTransfer.dropEffect = "none";
      return;
    }
    const destination = dropDirectory(event);
    const writable = !destination || deps.pathWritable(destination);
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
    if (!deps.ready()) return;
    void deps.upload(files, destination, undefined, directory);
  });
  for (const type of ["dragover", "drop"] as const) {
    document.addEventListener(type, (event) => {
      if (!externalFiles(event)) return;
      event.preventDefault();
      if (type === "drop" || !(event.target instanceof Node && fileTree.contains(event.target))) {
        clearFileDrop();
        event.dataTransfer.dropEffect = "none";
      }
    });
  }
  window.addEventListener("blur", clearFileDrop);
  document.addEventListener("dragend", clearFileDrop);
}
