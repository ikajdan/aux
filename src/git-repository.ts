// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type FS from "@isomorphic-git/lightning-fs";
import type { TreeEntry } from "isomorphic-git";
import type { GitLink } from "./gitlab-submodules.js";
import type { RepositorySnapshot } from "./gitlab-sync.js";
interface PathPlanEntry {
  path: string;
  directory: boolean;
  bytes?: Uint8Array;
}
export interface CommitAuthor {
  name: string;
  email: string;
  timestamp?: number;
  timezoneOffset?: number;
}

import git from "isomorphic-git";
import { safePath } from "./gitlab-sync.js";
export class Repository {
  declare fs: FS;
  declare p: FS.PromisifiedFS;
  declare dir: string;
  declare links: GitLink[];
  declare modes: Record<string, string>;
  declare opts: { fs: FS; dir: string };
  constructor(fs: FS, dir: string, links: GitLink[] = [], modes: Record<string, string> = {}) {
    this.fs = fs;
    this.p = fs.promises;
    this.dir = dir;
    this.links = links;
    this.modes = modes;
    this.opts = { fs, dir };
  }
  excluded(path: string) {
    return this.links.some((l) => path === l.path || path.startsWith(l.path + "/"));
  }
  assertWritable(path: string) {
    safePath(path);
    if (Object.entries(this.modes).some(([link, mode]) => mode === "120000" && (path === link || path.startsWith(link + "/") || link.startsWith(path + "/"))))
      throw new Error("Symbolic links are read-only. Edit their target files, or update the links in GitLab and pull.");
    if (this.excluded(path) || this.links.some((l) => l.path.startsWith(path + "/")) || (this.links.length && path === ".gitmodules"))
      throw new Error("Submodule files and .gitmodules are read-only. Update them in GitLab and pull.");
  }
  async mkdir(path: string) {
    let at = "";
    for (const part of path.split("/").filter(Boolean)) {
      at += "/" + part;
      try {
        await this.p.mkdir(at);
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
    }
  }
  async init() {
    await this.mkdir(this.dir);
    await git.init({ ...this.opts, defaultBranch: "local" });
  }
  async write(path: string, bytes: Uint8Array | string) {
    this.assertWritable(path);
    await this.mkdir(`${this.dir}/${path}`.split("/").slice(0, -1).join("/"));
    await this.p.writeFile(`${this.dir}/${path}`, bytes);
  }
  async createDirectory(path: string) {
    this.assertWritable(path);
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent) this.assertWritable(parent);
    await this.assertAvailable(path);
    await this.p.mkdir(`${this.dir}/${path}`);
  }
  async assertAvailable(path: string) {
    this.assertWritable(path);
    try {
      await this.p.stat(`${this.dir}/${path}`);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    throw new Error("A file or folder with that name already exists.");
  }
  async directories(path = ""): Promise<string[]> {
    const result = [];
    for (const name of await this.p.readdir(this.dir + (path ? "/" + path : ""))) {
      if (name === ".git") continue;
      const relative = path ? `${path}/${name}` : name;
      if ((await this.p.stat(`${this.dir}/${relative}`)).isDirectory()) {
        result.push(relative, ...(await this.directories(relative)));
      }
    }
    return result.sort();
  }
  async deletePath(source: string) {
    const plan: PathPlanEntry[] = [];
    const inspect = async (path: string): Promise<void> => {
      this.assertWritable(path);
      const directory = (await this.p.stat(`${this.dir}/${path}`)).isDirectory();
      if (directory) {
        for (const name of await this.p.readdir(`${this.dir}/${path}`)) await inspect(`${path}/${name}`);
      }
      plan.push({ path, directory });
    };
    await inspect(source);
    for (const { path, directory } of plan) {
      if (directory) await this.p.rmdir(`${this.dir}/${path}`);
      else await this.p.unlink(`${this.dir}/${path}`);
    }
  }
  async copyPath(source: string, target: string) {
    safePath(source);
    this.assertWritable(target);
    if (source === target || target.startsWith(source + "/")) throw new Error("Cannot copy an item into itself.");
    const parent = target.split("/").slice(0, -1).join("/");
    if (parent) this.assertWritable(parent);
    await this.assertAvailable(target);
    const plan: PathPlanEntry[] = [];
    const inspect = async (from: string, to: string): Promise<void> => {
      safePath(from);
      this.assertWritable(to);
      const directory = (await this.p.stat(`${this.dir}/${from}`)).isDirectory();
      plan.push({ path: to, directory, bytes: directory ? null : await this.p.readFile(`${this.dir}/${from}`) });
      if (directory) {
        for (const name of await this.p.readdir(`${this.dir}/${from}`)) {
          if (name !== ".git") await inspect(`${from}/${name}`, `${to}/${name}`);
        }
      }
    };
    await inspect(source, target);
    const created: PathPlanEntry[] = [];
    try {
      for (const entry of plan) {
        await this.assertAvailable(entry.path);
        const path = `${this.dir}/${entry.path}`;
        if (entry.directory) {
          await this.p.mkdir(path);
          created.push(entry);
        } else {
          created.push(entry);
          await this.p.writeFile(path, entry.bytes);
        }
      }
    } catch (error) {
      const failures = [];
      for (const entry of created.reverse()) {
        try {
          const path = `${this.dir}/${entry.path}`;
          if (entry.directory) await this.p.rmdir(path);
          else await this.p.unlink(path);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (failures.length) throw new Error(`Copy failed and some destination items could not be removed. Check ${target}. ${error.message}`);
      throw error;
    }
  }
  async rename(source: string, target: string) {
    this.assertWritable(source);
    this.assertWritable(target);
    if (source === target) return;
    if (target.startsWith(source + "/")) throw new Error("Cannot move a folder into itself.");
    const sourceStat = await this.p.stat(`${this.dir}/${source}`);
    if (sourceStat.isDirectory()) {
      for (const path of await this.files(source)) {
        this.assertWritable(path);
        this.assertWritable(target + path.slice(source.length));
      }
    }
    try {
      await this.p.stat(`${this.dir}/${target}`);
      throw new Error("Destination already exists.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parents = target.split("/").slice(0, -1);
    for (let i = 1; i <= parents.length; i++) {
      const path = parents.slice(0, i).join("/");
      this.assertWritable(path);
      try {
        if (!(await this.p.stat(`${this.dir}/${path}`)).isDirectory()) throw new Error(`Not a folder: ${path}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const created: string[] = [];
    try {
      for (let i = 1; i <= parents.length; i++) {
        const path = `${this.dir}/${parents.slice(0, i).join("/")}`;
        try {
          await this.p.mkdir(path);
          created.push(path);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
      // LightningFS moves the existing entry only after both parent lookups succeed.
      await this.p.rename(`${this.dir}/${source}`, `${this.dir}/${target}`);
      const movedModes = Object.entries(this.modes).filter(([path]) => path === source || path.startsWith(source + "/"));
      for (const [path] of movedModes) delete this.modes[path];
      for (const [path, mode] of movedModes) this.modes[target + path.slice(source.length)] = mode;
    } catch (error) {
      for (const path of created.reverse()) {
        try {
          await this.p.rmdir(path);
        } catch {
          /* Leave nonempty parents intact. */
        }
      }
      throw error;
    }
  }
  async files(path = ""): Promise<string[]> {
    const result = [];
    for (const name of await this.p.readdir(this.dir + (path ? "/" + path : ""))) {
      if (name === ".git") continue;
      const relative = path ? `${path}/${name}` : name;
      if ((await this.p.stat(`${this.dir}/${relative}`)).isDirectory()) result.push(...(await this.files(relative)));
      else result.push(relative);
    }
    return result.sort();
  }
  async changes() {
    return (await git.statusMatrix(this.opts)).filter(([path, h, w, s]) => !this.excluded(path) && (h !== w || w !== s));
  }
  async head() {
    return git.resolveRef({ ...this.opts, ref: "HEAD" });
  }
  async commit(message: string, author: CommitAuthor) {
    for (const [filepath, , work] of await this.changes()) {
      if (work === 0) await git.remove({ ...this.opts, filepath });
      else await git.add({ ...this.opts, filepath });
    }
    if (!this.links.length && !Object.keys(this.modes).length) return git.commit({ ...this.opts, message, author });
    // Preserve imported modes that LightningFS cannot represent, alongside gitlinks.
    const entries: TreeEntry[] = [];
    for (const path of await git.listFiles(this.opts)) {
      if (this.excluded(path)) continue;
      const mode = this.modes[path] ?? ((await this.p.stat(`${this.dir}/${path}`)).mode & 0o111 ? "100755" : "100644");
      entries.push({ path, mode, type: "blob", oid: await git.writeBlob({ ...this.opts, blob: await this.p.readFile(`${this.dir}/${path}`) }) });
    }
    entries.push(
      ...this.links.filter((l) => !this.links.some((p) => l.path.startsWith(p.path + "/"))).map<TreeEntry>((l) => ({ ...l, mode: "160000", type: "commit" })),
    );
    const build = async (items: TreeEntry[]): Promise<string> => {
      const tree: TreeEntry[] = [],
        groups = new Map<string, TreeEntry[]>();
      for (const item of items) {
        const [first, ...rest] = item.path.split("/");
        if (!rest.length) tree.push({ path: first, mode: item.mode, type: item.type, oid: item.oid });
        else {
          if (!groups.has(first)) groups.set(first, []);
          groups.get(first).push({ ...item, path: rest.join("/") });
        }
      }
      for (const [path, children] of groups) tree.push({ path, mode: "040000", type: "tree", oid: await build(children) });
      return git.writeTree({ ...this.opts, tree });
    };
    return git.commit({ ...this.opts, message, author, tree: await build(entries) });
  }
  async snapshot(ref: string): Promise<RepositorySnapshot> {
    const result: RepositorySnapshot = {};
    for (const path of await git.listFiles({ ...this.opts, ref })) {
      if (this.excluded(path)) continue;
      const { blob, oid } = await git.readBlob({ ...this.opts, oid: ref, filepath: path });
      // Gitlinks and their materialized files are never REST file actions.
      const parts = path.split("/");
      let treeOid = (await git.readCommit({ ...this.opts, oid: ref })).commit.tree;
      let entry: TreeEntry;
      for (const part of parts) {
        entry = (await git.readTree({ ...this.opts, oid: treeOid })).tree.find((e) => e.path === part);
        treeOid = entry.oid;
      }
      result[path] = { oid, bytes: blob, mode: entry.mode };
    }
    return result;
  }
  async unpublishedCommitCount(baseline: string) {
    const commits = await git.log(this.opts);
    const count = commits.findIndex((entry) => entry.oid === baseline);
    if (count < 0) throw new Error("Published baseline is not in local commit history.");
    return count;
  }
  async history() {
    return git.log({ ...this.opts, depth: 30 });
  }
}
