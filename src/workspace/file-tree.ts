// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { icon, type IconName } from "../ui-icons.js";
import { handleMenuKeydown } from "../ui/menu-keyboard.js";

type ProjectId = string | number;

export interface FileTreeState {
  readonly busy: boolean;
  readonly workspaceReady: boolean;
  readonly repo: { readonly dir: string } | null;
  readonly treeClipboard: { readonly dir: string; readonly path: string; readonly type: "copy" | "cut" } | null;
  readonly selectedTreePath: string | null;
  readonly file: string | null;
  readonly changedPaths: ReadonlySet<string>;
  readonly dirty: boolean;
  readonly treeProject: ProjectId | null;
  readonly project: ProjectId;
  readonly links?: readonly { readonly path: string }[];
}

export interface FileTreeCallbacks {
  setSelectedPath(path: string): void;
  setTreeProject(project: ProjectId): void;
  pathWritable(path: string): boolean;
  actionDisabled(id: string): boolean;
  menuAction(id: IconName, label: string, path: string, destination: string): void;
  fileButton(name: string, path: string, image: "text" | "file"): HTMLButtonElement;
  syncActions(): void;
}

/** UI only: operation dispatch and workspace mutations remain with the caller. */
export function createFileTree(tree: HTMLElement, getState: () => FileTreeState, callbacks: FileTreeCallbacks) {
  let treeMenu: HTMLDivElement;
  let treeMenuOrigin: HTMLElement;
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
    const { busy, repo, workspaceReady, treeClipboard } = getState();
    if (busy || !repo || !workspaceReady) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>("button[data-path], summary[data-path]");
    const path = row?.dataset.path || "";
    callbacks.setSelectedPath(path);
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
            ? !callbacks.pathWritable(path)
            : id === "paste"
              ? !treeClipboard ||
                treeClipboard.dir !== repo.dir ||
                Boolean(destination && !callbacks.pathWritable(destination)) ||
                destination === treeClipboard.path ||
                destination.startsWith(treeClipboard.path + "/")
              : false;
      } else item.disabled = id === "download" ? false : callbacks.actionDisabled(id);
      item.onclick = () => {
        closeTreeMenu(true);
        if (getState().busy) return;
        callbacks.menuAction(id, label, path, destination);
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
  tree.tabIndex = 0;
  tree.addEventListener("contextmenu", (event) => openTreeMenu(event));

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
    const { changedPaths, dirty, file, selectedTreePath, treeClipboard, repo } = getState();
    const changedDirectories = new Set<string>();
    const editedPaths = new Set([...changedPaths, ...(dirty && file ? [file] : [])]);
    for (const path of editedPaths) {
      const parts = path.split("/");
      while (parts.length > 1) {
        parts.pop();
        changedDirectories.add(parts.join("/"));
      }
    }
    for (const item of tree.querySelectorAll<HTMLElement>("button[data-path], summary[data-path]")) {
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
    callbacks.syncActions();
  }
  function expandTreePath(path: string) {
    for (const details of tree.querySelectorAll("details")) {
      if (path === details.dataset.path || path.startsWith(details.dataset.path + "/")) details.open = true;
    }
  }
  function renderTree(paths: string[], directories: string[] = []) {
    closeTreeMenu();
    const { treeProject, project, links } = getState();
    const expanded = new Set(treeProject === project ? [...tree.querySelectorAll<HTMLElement>("details[open]")].map((d) => d.dataset.path) : []);
    callbacks.setTreeProject(project);
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
          if (links?.some((link) => link.path === details.dataset.path)) {
            const label = document.createElement("span");
            label.className = "tree-submodule-label";
            label.textContent = "(submodule)";
            folderName.append(document.createTextNode(" "), label);
          }
          summary.onclick = () => {
            if (getState().busy) return;
            callbacks.setSelectedPath(summary.dataset.path);
            syncTree();
          };
          summary.onfocus = () => {
            if (getState().busy) return;
            callbacks.setSelectedPath(summary.dataset.path);
            syncTree();
          };
          details.ontoggle = () => summary.querySelector(".icon").replaceWith(icon(details.open ? "open" : "folder"));
          details.append(summary, list(child, prefix + name + "/"));
          li.append(details);
        } else {
          const b = callbacks.fileButton(name, child, /\.(tex|bib|sty|cls|txt|md)$/i.test(child) ? "text" : "file");
          b.dataset.path = child;
          b.onfocus = () => {
            if (getState().busy) return;
            callbacks.setSelectedPath(child);
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
    tree.replaceChildren(list(root));
    if (!root.size) tree.textContent = "No files yet. Create or upload a file.";
    syncTree();
  }

  return { renderTree, syncTree, expandTreePath, openTreeMenu, closeTreeMenu };
}
