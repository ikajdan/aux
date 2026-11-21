// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ApplicationElements {
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
export function $<K extends keyof ApplicationElements>(id: K): ApplicationElements[K];
export function $<T extends HTMLElement = HTMLElement>(id: string): T;
export function $(id: string): HTMLElement {
  return document.getElementById(id);
}
