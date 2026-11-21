// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { $ } from "../ui/application-elements.js";
import { icon } from "../ui-icons.js";
import { confirmDialog, promptDialog, alertDialog, installInputConfirmation } from "../modal-dialogs.js";
import { createMergeRequest, publishMergeRequestBranch, getProjectDefaultBranch, findOpenMergeRequest, hasOpenMergeRequest, type MergeRequestPublication, type MergeRequestResult } from "../gitlab-merge-request.js";
import { changedActions, type makeAPI } from "../gitlab-sync.js";
import { serverConfig } from "../server-config.js";
import type { Repository } from "../git-repository.js";
import type { createSelect } from "../select-control.js";
import type { ApplicationProject, ApplicationWorkspace, RemoteBranch, WorkspaceWarning, Operation, OperationOptions, OperationResult, StatusState } from "../application-types.js";
import { publishingAvailability, type MergeRequestState } from "./publishing-state.js";

export interface PublishingDependencies {
  api: ReturnType<typeof makeAPI>;
  getMeta(): ApplicationWorkspace | null;
  getProject(): ApplicationProject | null;
  getRepository(): Repository;
  getFile(): string;
  getWorkspaces(): Record<string, ApplicationWorkspace>;
  isBusy(): boolean;
  isWorkspaceReady(): boolean;
  setMeta(meta: ApplicationWorkspace): void;
  setWorkspaces(workspaces: Record<string, ApplicationWorkspace>): void;
  persist(workspaces: Record<string, ApplicationWorkspace>): void;
  resolveEditorDraft(saveLabel?: string, discardLabel?: string): Promise<boolean>;
  warningState(meta: ApplicationWorkspace): WorkspaceWarning;
  refreshWarning(meta: ApplicationWorkspace, repo: Repository): Promise<unknown>;
  markWorkspace(meta?: ApplicationWorkspace): void;
  refresh(): Promise<unknown>;
  pull(force: boolean, options: { build: boolean }): Promise<OperationResult>;
  openFile(path: string): Promise<unknown>;
  setSidebarBranches(names: string[]): void;
  branchSelect: ReturnType<typeof createSelect>;
  targetBranchSelect: ReturnType<typeof createSelect>;
  updatePageTitle(): void;
  restorePublishingFocus(): void;
  status(message: string, state: StatusState): void;
  run(operation: Operation, label: string, quiet: boolean, catalogRefresh: boolean, options: OperationOptions): Promise<unknown>;
}

export function createPublishing(d: PublishingDependencies) {
  const { api } = d;
  const targetBranchCache = new Map<string, string[]>();
  function updateTargetBranches(names = targetBranchCache.get(String(d.getProject()?.id)) || []) {
    const select = $("target-remote-branches");
    const target = $("target").value;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.hidden = true;
    placeholder.disabled = true;
    placeholder.textContent = "Select branch…";
    const addNew = document.createElement("option");
    addNew.value = ":new-branch";
    addNew.textContent = "New branch…";
    addNew.dataset.separator = "true";
    select.replaceChildren(
      placeholder,
      ...[...new Set([...names, ...(target ? [target] : [])])]
        .sort((a, b) => a.localeCompare(b))
        .map((name) => {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = name;
          return option;
        }),
      addNew,
    );
    select.value = target;
    select.disabled = d.isBusy() || currentPublishingAvailability().pushDisabled;
    d.targetBranchSelect.rebuild();
  }
  function installUI() {
    $("target-remote-branches").onchange = async () => {
      const selected = $("target-remote-branches").value;
      if (d.isBusy() || !selected) return;
      if (selected === ":new-branch") {
        d.targetBranchSelect.setValue($("target").value);
        const name = await promptDialog("Enter a name for the new remote branch. It will be created when you push commits.", {
          title: "New remote branch",
          label: "Branch name",
          icon: "branch",
          confirmLabel: "Use branch",
        });
        if (!name?.trim()) return;
        $("target").value = name.trim();
      } else {
        $("target").value = selected;
      }
      updateTargetBranches();
    };
    $("publishing").onclick = () =>
      d.run(openPublishing, "Opening Publish Changes", true, false, {
        completion: false,
        allowSaveFailure: true,
        transient: true,
      });
  
    $("publishing-dialog").onclose = () => {
      mergeRequestCheckSequence++;
      d.updatePageTitle();
      d.restorePublishingFocus();
    };
    for (const [input, action] of [
      ["message", "commit"],
      ["target", "push"],
      ["mr-title", "create-mr"],
    ] as const) {
      installInputConfirmation($<HTMLInputElement>(input), $<HTMLButtonElement>(action));
    }
  }
  async function loadTargetBranches() {
    const activeProject = d.getProject();
    const token = $("token").value;
    if (!activeProject) return;
    try {
      const remote = await api.pages<RemoteBranch>(`projects/${encodeURIComponent(activeProject.id)}/repository/branches`);
      if (d.getProject() !== activeProject || $("token").value !== token) return;
      targetBranchCache.set(
        String(activeProject.id),
        remote.map(({ name }) => name),
      );
      updateTargetBranches();
    } catch (error) {
      if (d.getProject() === activeProject && $("token").value === token) d.status(`Could not refresh remote branches: ${error.message}`, "error");
    }
  }
  async function openPublishing() {
    if ($("publishing-dialog").open) return;
    if (!(await d.resolveEditorDraft("Save and continue", "Discard and continue"))) return false;
    $("mr-result").textContent = "";
  
    if (!$("publishing-dialog").open) $("publishing-dialog").showModal();
    updateTargetBranches();
    void loadTargetBranches();
    const pending = pendingMergeRequest();
    $("mr-title").value = pending?.title || "";
    void refreshBranchMergeRequest();
    if (d.getMeta() && d.getRepository()) void d.refreshWarning(d.getMeta(), d.getRepository());
    d.updatePageTitle();
  }
  function mergeRequestTarget() {
    return d.getProject()?.default_branch?.trim() || undefined;
  }
  type BranchMergeRequestState = MergeRequestState;
  let mergeRequestCheck: { dir: string; token: string; state: BranchMergeRequestState } | null = null;
  let mergeRequestCheckSequence = 0;
  async function refreshBranchMergeRequest() {
    if (!d.getMeta() || !d.getProject()) return;
    const activeMeta = d.getMeta();
    const token = $("token").value;
    const sequence = ++mergeRequestCheckSequence;
    mergeRequestCheck = { dir: activeMeta.dir, token, state: "checking" };
    updateMergeRequestControls();
    const current = () => sequence === mergeRequestCheckSequence && d.getMeta()?.dir === activeMeta.dir && $("token").value === token && $("publishing-dialog").open;
    try {
      const target = await getProjectDefaultBranch(api, d.getProject().id);
      if (!current()) return;
      d.getProject().default_branch = target;
      const open = await hasOpenMergeRequest(api, d.getProject().id, activeMeta.branch);
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
    if (!d.getMeta()) return;
    publishingSuccess.set(d.getMeta().dir, { ...publishingSuccess.get(d.getMeta().dir), [action]: true });
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
    if (!d.getMeta() || !target) return;
    const pending = pendingMergeRequests.get(d.getMeta().dir);
    if (pending?.source === d.getMeta().branch && pending.target === target) return pending;
    try {
      const value = JSON.parse(localStorage.getItem(`aux-mr:${d.getMeta().dir}`) || "null");
      if (value?.source === d.getMeta().branch && value.target === target && [value.title, value.commit].every((v) => typeof v === "string" && v)) return value;
    } catch {
      /* Ignore invalid saved publication metadata. */
    }
  }
  function currentPublishingAvailability() {
    const state = d.getMeta() && d.warningState(d.getMeta());
    const mergeRequestState = mergeRequestCheck?.dir === d.getMeta()?.dir && mergeRequestCheck?.token === $("token").value ? mergeRequestCheck.state : "checking";
    return publishingAvailability({
      branch: d.getMeta()?.branch,
      targetBranch: mergeRequestTarget(),
      commitsKnown: Boolean(state?.known),
      unpublished: Boolean(state?.unpublished),
      mergeRequestState,
    });
  }
  function updateCommitControls() {
    const state = d.getMeta() && d.warningState(d.getMeta());
    const disabled = !d.getMeta() || Boolean(state?.dirtyKnown && !state.dirty);
    $("commit-options").setAttribute("aria-disabled", String(disabled));
    $<HTMLButtonElement>("commit").disabled = d.isBusy() || disabled;
    $<HTMLInputElement>("message").disabled = d.isBusy() || disabled;
    $("commit-description").textContent = disabled ? "No saved changes to commit." : "Record saved changes in this browser before publishing.";
    showPublishingSuccess(
      "commit-heading",
      "Done",
      Boolean(d.getMeta() && publishingSuccess.get(d.getMeta().dir)?.committed && state?.dirtyKnown && !state.dirty && !state.draft),
    );
  }
  function updatePushControls() {
    const { pushDisabled } = currentPublishingAvailability();
    $("push-options").setAttribute("aria-disabled", String(pushDisabled));
    const state = d.getMeta() && d.warningState(d.getMeta());
    showPublishingSuccess(
      "push-heading",
      "Done",
      Boolean(d.getMeta() && publishingSuccess.get(d.getMeta().dir)?.pushed && state?.known && !state.unpublished && !state.dirty && !state.draft),
    );
    $<HTMLButtonElement>("push").disabled = d.isBusy() || pushDisabled;
    $("target").disabled = d.isBusy() || pushDisabled;
    updateTargetBranches();
    $("publish-description").textContent =
      pushDisabled && d.getMeta() && d.warningState(d.getMeta()).known
        ? "No commits to push."
        : "Choose an existing target branch or name a new one. New branches are created when you push.";
  }
  function updateMergeRequestControls() {
    updateCommitControls();
    const pending = pendingMergeRequest();
    const { mergeRequestDisabled, mergeRequestChecking } = currentPublishingAvailability();
  
    $("merge-request-options").hidden = false;
    $("create-mr").replaceChildren(icon("branch"), document.createTextNode(pending ? "Retry" : "Open merge request"));
    $("merge-request-options").setAttribute("aria-disabled", String(mergeRequestDisabled));
    const requestOpen = mergeRequestCheck?.dir === d.getMeta()?.dir && mergeRequestCheck?.token === $("token").value && mergeRequestCheck.state === "open";
    showPublishingSuccess("mr-heading", "Done", Boolean(requestOpen && publishingSuccess.get(d.getMeta().dir)?.opened));
  
    $<HTMLButtonElement>("create-mr").disabled = d.isBusy() || mergeRequestDisabled || mergeRequestChecking;
    $("mr-title").disabled = d.isBusy() || mergeRequestDisabled || mergeRequestChecking;
    $("mr-help").textContent = requestOpen
      ? "A merge request is already open for this branch."
      : !mergeRequestTarget()
        ? "The project’s default branch is unavailable. Refresh documents and try again."
        : d.getMeta()?.branch === mergeRequestTarget()
          ? "The active branch is this project’s default branch."
          : pending
            ? "Retry creating the merge request. Commits will not be pushed again."
            : "The merge request will be based on the currently active branch.";
    updatePushControls();
    $("push").replaceChildren(icon("push"), document.createTextNode("Push commits"));
  }
  async function switchToPublishedBranch(branch: string) {
    const previousBranch = d.getMeta().branch;
    const previousFile = d.getFile();
    const branches = [...$("branches").options].map((option) => option.value);
    d.setSidebarBranches([...new Set([...branches, branch])]);
    d.branchSelect.setValue(branch);
    try {
      const result = await d.pull(false, { build: false });
      if (result === false || d.getMeta()?.branch !== branch || !d.isWorkspaceReady()) throw new Error("Could not open the published branch.");
      if (previousFile && previousFile !== d.getFile() && (await d.getRepository().files()).includes(previousFile)) await d.openFile(previousFile);
      await d.refresh();
    } catch (error) {
      if (d.getMeta()?.branch === previousBranch) d.branchSelect.setValue(previousBranch);
      throw error;
    }
  }
  async function showPublishedBranch(branch: string, previousBranch: string, createdMergeRequest?: MergeRequestResult) {
    const switchBranch = d.getMeta().branch !== branch;
    let switchError = "";
    try {
      if (switchBranch) await switchToPublishedBranch(branch);
      else await d.refresh();
    } catch (error) {
      switchError = error.message || String(error);
    }
    let request = createdMergeRequest;
    let lookupFailed = false;
    if (!request) {
      try {
        request = await findOpenMergeRequest(api, d.getProject().id, branch);
      } catch (error) {
        lookupFailed = true;
        console.warn("Published successfully, but could not retrieve the merge request", error);
      }
    }
    const projectURL = `${serverConfig.gitlabUrl}/${d.getProject().path_with_namespace.split("/").map(encodeURIComponent).join("/")}`;
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
      mergeRequestCheck = { dir: d.getMeta().dir, token: $("token").value, state: request ? "open" : lookupFailed ? "error" : "none" };
      updateMergeRequestControls();
    }
    const published = createdMergeRequest ? `Merge request !${createdMergeRequest.iid} is open for branch ${branch}.` : `Published to ${branch}.`;
    const message = switchError
      ? `${published} Could not switch automatically: ${switchError}\n\nYour local work has been kept.`
      : switchBranch
        ? `${published} You’re now editing that branch. Your ${previousBranch} workspace is still saved in this browser.`
        : published;
    d.status(switchError ? message : published, switchError ? "error" : "ready");
    await alertDialog(message, { title: "Published", icon: switchError ? "warning" : "ready", links });
    return !switchError;
  }
  async function publishMergeRequest() {
    if (!d.getMeta() || !d.getProject()) throw new Error("Open a project before creating a merge request.");
    const target = await getProjectDefaultBranch(api, d.getProject().id);
    d.getProject().default_branch = target;
    updateMergeRequestControls();
    if (d.getMeta().branch === target) throw new Error(`Open a merge request from a working branch, not the default branch (${target}).`);
    if (!(await d.resolveEditorDraft())) return false;
  
    let pending = pendingMergeRequest();
    if (!pending) {
      const source = d.getMeta().branch;
      if ((await d.getRepository().changes()).length) throw new Error("Commit all working changes before creating a merge request.");
      await api.request<RemoteBranch>(`projects/${encodeURIComponent(d.getProject().id)}/repository/branches/${encodeURIComponent(target)}`);
      const unpublished = (await d.getRepository().head()) !== d.getMeta().base;
      const logs = await d.getRepository().history();
      const latest = logs.find((entry) => !/^Pull [^\r\n]+ @ [0-9a-f]{40}\s*$/i.test(entry.commit.message));
      const title = $("mr-title").value.trim() || latest?.commit.message.trim().split(/\r?\n/)[0] || `Merge ${source} into ${target}`;
  
      if (unpublished && (await push({ branch: source })) === false) return false;
      pending = { source, target, title, commit: d.getMeta().remote };
      // Save before the MR POST so a failed/lost response can be retried without republishing.
      pendingMergeRequests.set(d.getMeta().dir, pending);
      try {
        localStorage.setItem(`aux-mr:${d.getMeta().dir}`, JSON.stringify(pending));
      } catch {
        console.warn("MR retry state could not be saved; keep this tab open to retry.");
      }
    }
    pending.title = $("mr-title").value.trim() || pending.title;
    pendingMergeRequests.set(d.getMeta().dir, pending);
    try {
      localStorage.setItem(`aux-mr:${d.getMeta().dir}`, JSON.stringify(pending));
    } catch {
      /* In-memory retry remains available. */
    }
    let result: MergeRequestResult;
    try {
      result = await createMergeRequest(api, d.getProject().id, pending);
    } catch (error) {
      throw new Error(`Changes are published to ${pending.source}, but merge request creation failed. Retry here without pushing again. ${error.message}`);
    }
    recordPublishingSuccess("opened");
    const previousBranch = d.getMeta().branch;
    pendingMergeRequests.delete(d.getMeta().dir);
    try {
      localStorage.removeItem(`aux-mr:${d.getMeta().dir}`);
    } catch {
      /* An existing MR is detected on retry. */
    }
    const completed = await showPublishedBranch(pending.source, previousBranch, result);
    if (completed) $("publishing-dialog").close();
    return { statusHandled: true };
  }
  async function push({ branch }: { branch?: string } = {}): Promise<OperationResult> {
    if (!(await d.resolveEditorDraft())) return false;
    if ((await d.getRepository().changes()).length) throw new Error("Commit all working changes before pushing.");
    const target = branch || $("target").value.trim();
    if (!target) throw new Error("Choose a target branch.");
    const base = await d.getRepository().snapshot(d.getMeta().base),
      current = await d.getRepository().snapshot(await d.getRepository().head());
    for (const [path, mode] of Object.entries(d.getMeta().modes)) {
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
    d.status("Pushing commits…", "busy");
    let remote: RemoteBranch;
    try {
      remote = await api.request<RemoteBranch>(`projects/${d.getProject().id}/repository/branches/${encodeURIComponent(target)}`);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    if (remote && remote.commit.id !== d.getMeta().remote)
      throw new Error("Target differs from the pulled baseline. Push to a new branch, or reconcile in GitLab. No force push performed.");
    const localHead = await d.getRepository().head();
    const logs = await d.getRepository().history();
    const message = $("message").value.trim() || logs[0].commit.message;
    const author = { name: $("author").value.trim(), email: $("email").value.trim() };
    let result: { id: string };
    if (!remote) {
      // Reserve the branch first so file guards use it, rather than GitLab's default branch.
      result = {
        id: await publishMergeRequestBranch(api, d.getProject().id, target, d.getMeta().branch, d.getMeta().remote, message, author, actions),
      };
    } else {
      // Keep file-level guards when updating an existing branch.
      for (const action of actions.filter((a) => a.action === "update" || a.action === "delete")) {
        const f = await api.request<{ last_commit_id: string }>(
          `projects/${d.getProject().id}/repository/files/${encodeURIComponent(action.file_path)}?ref=${d.getMeta().remote}`,
        );
        action.last_commit_id = f.last_commit_id;
      }
      result = await api.request<{ id: string }>(`projects/${d.getProject().id}/repository/commits`, {
        branch: target,
        commit_message: message,
        author_name: author.name,
        author_email: author.email,
        actions,
      });
    }
    const next = {
      ...d.getMeta(),
      publication: { localHead, branch: target, remoteCommit: result.id },
      ...(target === d.getMeta().branch ? { base: localHead, remote: result.id } : {}),
    };
    const published = { ...d.getWorkspaces(), [`${d.getMeta().project}:${d.getMeta().branch}`]: next };
    try {
      d.persist(published);
    } catch (error) {
      throw new Error(
        `Commits were pushed to ${target}, but saving their local publication status failed. Do not push again without checking GitLab. ${error.message}`,
      );
    }
    d.setWorkspaces(published);
    d.setMeta(next);
    if (target !== d.getMeta().branch) {
      const previousBranch = d.getMeta().branch;
      d.status(`Commits pushed to ${target}.`, "ready");
      const switchBranch = await confirmDialog(
        `Your commits were successfully pushed to ${target}.\n\nSwitch to ${target} to continue editing the branch with your changes?`,
        { title: "Commits pushed", icon: "ready", confirmLabel: "Switch branch", confirmIcon: "branch", cancelLabel: "Stay on current branch" },
      );
      if (!switchBranch) {
        d.status(`Commits pushed to ${target}. You’re still editing ${previousBranch}.`, "ready");
        return { statusHandled: true };
      }
      const committed = publishingSuccess.get(d.getMeta().dir)?.committed;
      const switched = await showPublishedBranch(target, previousBranch);
      if (switched && d.getMeta().branch === target) {
        if (committed) recordPublishingSuccess("committed");
        recordPublishingSuccess("pushed");
        updateCommitControls();
        updatePushControls();
      }
      return { statusHandled: true };
    } else {
      d.markWorkspace();
      recordPublishingSuccess("pushed");
    }
    await d.refresh();
  }
  async function commit(): Promise<void | false> {
    if (!(await d.resolveEditorDraft())) return false;
    const message = $("message").value.trim(),
      name = $("author").value.trim(),
      email = $("email").value.trim();
    if (!message || !name || !email) throw new Error("Enter commit message, author and email.");
    if (!(await d.getRepository().changes()).length) throw new Error("Nothing to commit.");
    d.markWorkspace();
    await d.getRepository().commit(message, { name, email });
    recordPublishingSuccess("committed");
    await d.refresh();
  }

  return {
    targetBranchCache,
    updateTargetBranches,
    loadTargetBranches,
    openPublishing,
    refreshBranchMergeRequest,
    updateCommitControls,
    updatePushControls,
    updateMergeRequestControls,
    currentPublishingAvailability,
    switchToPublishedBranch,
    push,
    publishMergeRequest,
    commit,
    installUI,
  };
}
