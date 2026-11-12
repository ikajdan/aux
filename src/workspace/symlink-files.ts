// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

type ImportedFile = { path: string; bytes: Uint8Array; mode: string };
type Limits = { snapshotFiles: number; snapshotBytes: number };

interface Entry {
  path: string;
  children: Map<string, Entry>;
  file?: ImportedFile;
  target?: string;
}

/** Materialize Git symlink blobs without creating filesystem symlinks. */
export function materializeSymlinkFiles(files: ImportedFile[], limits: Limits): { path: string; bytes: Uint8Array }[] {
  const root: Entry = { path: "", children: new Map() };
  const entries = new Map<string, Entry>([["", root]]);
  const fail = (path: string, reason: string): never => {
    throw new Error(`Cannot materialize "${path}": ${reason}.`);
  };
  const unsafe = (path: string) => path.startsWith("/") || /^[a-z]:/i.test(path)
    || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part.toLowerCase() === ".git");

  for (const file of files) {
    const parts = file.path.split("/");
    if (unsafe(file.path) || parts.some((part) => !part || part === "." || part === "..")) {
      fail(file.path, "invalid project file path");
    }
    let parent = root;
    for (const part of parts) {
      if (parent.file) fail(file.path, `file conflicts with parent "${parent.path}"`);
      const path = parent.path ? `${parent.path}/${part}` : part;
      let entry = parent.children.get(part);
      if (!entry) {
        entry = { path, children: new Map() };
        parent.children.set(part, entry);
        entries.set(path, entry);
      }
      parent = entry;
    }
    if (parent.file || parent.children.size) fail(file.path, "duplicate or conflicting file path");
    parent.file = file;
    if (file.mode === "120000") {
      let target: string;
      try {
        target = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes);
      } catch {
        fail(file.path, "symlink target is not valid UTF-8");
      }
      if (!target || unsafe(target)) fail(file.path, `unsafe symlink target ${JSON.stringify(target)}`);
      parent.target = target;
    }
  }

  function resolve(parts: string[], source: string, links: Set<Entry>): Entry {
    let current = root;
    for (const part of parts) {
      if (current.file) fail(source, `target traverses ordinary file "${current.path}"`);
      if (!part || part === ".") continue;
      if (part === "..") {
        if (current === root) fail(source, "symlink target escapes the project root");
        current = entries.get(current.path.split("/").slice(0, -1).join("/"))!;
        continue;
      }
      const child = current.children.get(part);
      if (!child) fail(source, `dangling symlink target; missing "${current.path ? `${current.path}/` : ""}${part}"`);
      if (child.target !== undefined) {
        if (links.has(child)) fail(source, `symlink cycle involving "${child.path}"`);
        links.add(child);
        const parentParts = child.path.split("/").slice(0, -1);
        current = resolve([...parentParts, ...child.target.split("/")], child.path, links);
        links.delete(child);
      } else {
        current = child;
      }
    }
    return current;
  }

  const output: { path: string; bytes: Uint8Array }[] = [];
  let bytes = 0;
  function expand(entry: Entry, path: string, directories: Set<Entry>) {
    if (entry.target !== undefined) {
      expand(resolve(entry.path.split("/"), entry.path, new Set()), path, directories);
    } else if (entry.file) {
      if (output.length >= limits.snapshotFiles) fail(path, `project exceeds the ${limits.snapshotFiles}-file limit`);
      bytes += entry.file.bytes.byteLength;
      if (bytes > limits.snapshotBytes) fail(path, `project exceeds the ${limits.snapshotBytes}-byte size limit`);
      output.push({ path, bytes: entry.file.bytes });
    } else {
      if (directories.has(entry)) fail(path, `directory symlink cycle involving "${entry.path || "/"}"`);
      directories.add(entry);
      for (const name of [...entry.children.keys()].sort()) {
        expand(entry.children.get(name)!, path ? `${path}/${name}` : name, directories);
      }
      directories.delete(entry);
    }
  }
  expand(root, "", new Set());
  return output.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
