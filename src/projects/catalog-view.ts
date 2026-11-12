// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { icon, type IconName } from "../ui-icons.js";
import { restoreFocus } from "../modal-dialogs.js";
import { projectGroupBadge } from "./project-badges.js";
import { projectTopics, renderProjectTopics } from "./project-topics.js";
import { groupCatalogRepositories, customRepositoryGroup } from "./custom-repositories.js";
import type { RepositoryGroup } from "./repository-groups.js";

export interface CatalogProject {
  id: string | number;
  topics?: string[];
  name?: string;
  path?: string;
  path_with_namespace: string;
  latestTag?: string;
  last_activity_at?: string;
  updated_at?: string;
}
export interface CatalogWorkspaceIndicator {
  label: string;
  kind: "changes";
  icon: IconName;
  detail: string;
}
interface CatalogViewOptions {
  repos: HTMLElement;
  refreshButton: HTMLElement;
  search: HTMLInputElement;
  topicFilters: HTMLElement;
  clearFilters: HTMLElement;
  sortButtons: HTMLElement[];
  gitlabUrl: string;
  repositoryGroups: RepositoryGroup[];
  storage: Pick<Storage, "getItem" | "setItem">;
  openProject: (project: CatalogProject, source: "title" | "action") => unknown;
  workspaceStatus: (id: CatalogProject["id"]) => CatalogWorkspaceIndicator[];
  reviewWorkspace: (id: CatalogProject["id"], kind: CatalogWorkspaceIndicator["kind"]) => unknown;
  requestRender: () => void;
}

export function createCatalogView({
  repos,
  refreshButton,
  search,
  topicFilters,
  clearFilters,
  sortButtons,
  gitlabUrl,
  repositoryGroups,
  storage,
  openProject,
  workspaceStatus,
  reviewWorkspace,
  requestRender,
}: CatalogViewOptions) {
  let projectSort = "name-asc";
  try {
    const saved = storage.getItem("aux-project-sort");
    if (["name-asc", "name-desc", "updated-desc", "updated-asc"].includes(saved)) projectSort = saved;
    else if (saved === "updated") projectSort = "updated-desc";
  } catch {
    // Keep name ordering when browser storage is unavailable.
  }
  function syncProjectSort() {
    for (const button of sortButtons) {
      const type = button.dataset.projectSort;
      const active = projectSort.startsWith(`${type}-`);
      const direction = active ? projectSort.split("-")[1] : type === "name" ? "asc" : "desc";
      const label = type === "name" ? "Name" : "Updated";
      button.setAttribute("aria-pressed", String(active));
      button.setAttribute("aria-label", `${label}, ${direction === "asc" ? "ascending" : "descending"}`);
      button.replaceChildren(label);
      if (active) button.append(icon(direction === "asc" ? "arrow-up" : "arrow-down"));
    }
  }
  syncProjectSort();
  let catalog: CatalogProject[] = [];
  let customRepositories: string[] = [];
  let dashboardRefreshing = false;
  const refreshingLinks = new WeakMap();
  const refreshingButtons = new WeakSet();
  const catalogHeadings = new Map<CatalogProject["id"], HTMLElement>();
  function showLatestTag(p: CatalogProject) {
    const heading = catalogHeadings.get(p.id);
    if (!heading) return;
    heading.querySelector(".repository-version")?.remove();
    if (typeof p.latestTag !== "string" || !p.latestTag) return;
    const badge = document.createElement("span");
    badge.className = "hint repository-version";
    badge.title = "Latest version tag";
    badge.append(icon("commit"), document.createTextNode(p.latestTag));
    heading.insertBefore(badge, heading.querySelector(".repository-workspace-status"));
  }
  function showWorkspaceStatus(id: CatalogProject["id"]) {
    const metadata = catalogHeadings.get(id) || catalogHeadings.get(Number(id));
    if (!metadata) return;
    const focusedKind = metadata.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.kind : null;
    metadata.querySelectorAll<HTMLElement>(".repository-workspace-status").forEach((indicator) => indicator.remove());
    for (const { label, detail, kind, icon: iconName } of workspaceStatus(id)) {
      const indicator = document.createElement("button");
      indicator.type = "button";
      indicator.className = "hint repository-workspace-status";
      indicator.dataset.kind = kind;
      indicator.title = detail;
      const p = catalog.find((p) => String(p.id) === String(id));
      indicator.setAttribute("aria-label", `Review local changes for ${p?.name || p?.path_with_namespace || id}`);
      indicator.onclick = () => reviewWorkspace(id, kind);
      indicator.append(icon(iconName), document.createTextNode(label));
      metadata.append(indicator);
      if (focusedKind === kind) restoreFocus(indicator);
    }
  }
  const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  function updateRepositoryTimes(lastRepositoriesRefresh: number) {
    const refresh = refreshButton;
    refresh.title = "Refresh documents · Not refreshed yet";
    if (Number.isFinite(lastRepositoriesRefresh) && lastRepositoriesRefresh > 0 && lastRepositoriesRefresh <= Date.now()) {
      const minutes = Math.floor((Date.now() - lastRepositoriesRefresh) / 60000);
      refresh.title = `Refresh documents · Last refreshed ${minutes < 1 ? "just now" : minutes < 60 ? relativeTime.format(-minutes, "minute") : minutes < 1440 ? relativeTime.format(-Math.floor(minutes / 60), "hour") : relativeTime.format(-Math.floor(minutes / 1440), "day")}`;
    }
    for (const time of repos.querySelectorAll("time")) {
      const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(time.dateTime)) / 1000));
      let label = "just now";
      for (const [unit, length] of [
        ["year", 31536000],
        ["month", 2592000],
        ["week", 604800],
        ["day", 86400],
        ["hour", 3600],
        ["minute", 60],
      ] as [Intl.RelativeTimeFormatUnit, number][]) {
        if (seconds >= length) {
          label = relativeTime.format(-Math.floor(seconds / length), unit);
          break;
        }
      }
      time.textContent = `Updated ${label}`;
    }
  }
  const selectedProjectTopics = new Set<string>();
  function syncProjectTopicFilters() {
    const available = new Map<string, string>();
    for (const p of catalog) {
      for (const label of projectTopics(p)) {
        const key = label.toLowerCase();
        if (!available.has(key)) available.set(key, label);
      }
    }
    for (const key of selectedProjectTopics) {
      if (!available.has(key)) selectedProjectTopics.delete(key);
    }
    const options = [["", "All"], ...[...available].sort((a, b) => a[1].localeCompare(b[1]))];
    const container = topicFilters;
    const signature = JSON.stringify(options);
    if (container.dataset.options !== signature) {
      const focused = container.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.projectTopic : null;
      container.replaceChildren(
        ...options.map(([key, label]) => {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "repository-tag project-topic-filter";
          chip.dataset.projectTopic = key;
          chip.textContent = label;
          chip.setAttribute("aria-controls", "repos");
          return chip;
        }),
      );
      container.dataset.options = signature;
      if (focused !== null) {
        (
          ([...container.children] as HTMLElement[]).find((chip) => chip.dataset.projectTopic === focused) || (container.firstElementChild as HTMLElement)
        ).focus({
          preventScroll: true,
        });
      }
    }
    for (const chip of [...container.children] as HTMLElement[]) {
      chip.setAttribute("aria-pressed", String(chip.dataset.projectTopic ? selectedProjectTopics.has(chip.dataset.projectTopic) : !selectedProjectTopics.size));
    }
  }
  function setDashboardRefreshing(refreshing: boolean) {
    dashboardRefreshing = refreshing;

    repos.setAttribute("aria-busy", String(refreshing));
    repos.classList.toggle("is-refreshing", refreshing);
    for (const link of repos.querySelectorAll<HTMLElement>(".repository-link")) {
      if (refreshing) {
        if (!refreshingLinks.has(link)) {
          refreshingLinks.set(link, { href: link.getAttribute("href"), tabindex: link.getAttribute("tabindex") });
        }
        link.removeAttribute("href");
        link.setAttribute("aria-disabled", "true");
        link.setAttribute("tabindex", "-1");
      } else if (refreshingLinks.has(link)) {
        const { href, tabindex } = refreshingLinks.get(link);
        if (href !== null) link.setAttribute("href", href);
        if (tabindex === null) link.removeAttribute("tabindex");
        else link.setAttribute("tabindex", tabindex);
        link.removeAttribute("aria-disabled");
        refreshingLinks.delete(link);
      }
    }
    for (const control of repos.querySelectorAll("button")) {
      if (refreshing && !control.disabled) {
        refreshingButtons.add(control);
        control.disabled = true;
      } else if (!refreshing && refreshingButtons.has(control)) {
        control.disabled = false;
        refreshingButtons.delete(control);
      }
    }
  }
  function renderCatalog(projects: CatalogProject[], paths: string[], lastRepositoriesRefresh: number) {
    catalog = projects;
    customRepositories = paths;
    syncProjectTopicFilters();
    const query = search.value.trim().toLowerCase();
    clearFilters.hidden = !query && !selectedProjectTopics.size;
    const matches = catalog
      .filter((p) => {
        const labels = new Set(projectTopics(p).map((label) => label.toLowerCase()));
        return [...selectedProjectTopics].every((label) => labels.has(label));
      })
      .filter((p) => [p.name, p.path, p.path_with_namespace].some((value) => (value || "").toLowerCase().includes(query)))
      .sort((a, b) => {
        const direction = projectSort.endsWith("-asc") ? 1 : -1;
        if (projectSort.startsWith("updated-")) {
          const aTime = Date.parse(a.last_activity_at || a.updated_at);
          const bTime = Date.parse(b.last_activity_at || b.updated_at);
          const aValid = Number.isFinite(aTime);
          const bValid = Number.isFinite(bTime);
          if (aValid !== bValid) return aValid ? -1 : 1;
          if (aValid && aTime !== bTime) return direction * (aTime - bTime);
        }
        const nameOrder =
          String(a.name || a.path || a.path_with_namespace || "").localeCompare(String(b.name || b.path || b.path_with_namespace || ""), undefined, {
            numeric: true,
          }) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
        return projectSort.startsWith("name-") ? direction * nameOrder : nameOrder;
      });

    catalogHeadings.clear();
    repos.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = catalog.length
        ? "No documents match your search and topic filters. Use Clear filters below to show all documents."
        : "No documents cached yet. Use Refresh documents to load available documents.";
      repos.append(empty);
    }
    for (const { group, projects } of groupCatalogRepositories(matches, repositoryGroups, customRepositories)) {
      if (!projects.length) continue;
      const section = document.createElement("section");
      section.className = "repository-group";
      section.setAttribute("aria-label", group.name);
      const groupHeading = document.createElement("h3");
      groupHeading.className = "repository-group-heading";
      if (group.path) {
        const groupLink = document.createElement("a");
        groupLink.href = `${gitlabUrl}/${group.path.split("/").map(encodeURIComponent).join("/")}`;
        groupLink.target = "_blank";
        groupLink.rel = "noopener noreferrer";
        groupLink.title = `Open ${group.path} in GitLab`;
        groupLink.append(document.createTextNode(group.name), icon("external"));
        groupHeading.append(groupLink);
      } else {
        groupHeading.textContent = group.name;
      }
      section.append(groupHeading);
      repos.append(section);
      for (const p of projects) {
        const appearance = projectGroupBadge(group, [...repositoryGroups, customRepositoryGroup], p);
        const row = document.createElement("article");
        row.className = "repository-card";
        const details = document.createElement("div");
        details.className = "repository-details";
        const badge = document.createElement("span");
        badge.className = `repository-badge repository-badge-tone-${appearance.tone}`;
        badge.textContent = appearance.letter;
        badge.setAttribute("aria-hidden", "true");
        const info = document.createElement("div");
        info.className = "repository-info";

        details.append(badge, info);
        const heading = document.createElement("h3");
        const name = document.createElement("button");
        name.type = "button";
        name.className = "repository-title";
        name.textContent = p.name || p.path || p.path_with_namespace;
        name.onclick = () => openProject(p, "title");
        heading.append(name);
        const labels = document.createElement("div");
        labels.className = "repository-topics";
        labels.setAttribute("role", "group");
        labels.setAttribute("aria-label", "Document topics");
        renderProjectTopics(labels, p);
        info.append(heading);
        row.append(details, labels);
        const metadata = document.createElement("div");
        metadata.className = "repository-metadata";
        info.append(metadata);

        const updatedAt = p.last_activity_at || p.updated_at;
        const updatedDate = new Date(updatedAt);
        if (updatedAt && Number.isFinite(updatedDate.getTime())) {
          const updated = document.createElement("p");
          updated.className = "hint";
          const time = document.createElement("time");
          time.dateTime = updatedDate.toISOString();
          time.title = updatedDate.toLocaleString();
          updated.append(icon("history"), time);
          metadata.append(updated);
        }
        catalogHeadings.set(p.id, metadata);
        showLatestTag(p);
        showWorkspaceStatus(p.id);
        const actions = document.createElement("div");
        actions.className = "repository-actions";
        const open = document.createElement("button");
        open.append(icon("editDocument"), document.createTextNode("Edit Document"));
        open.type = "button";
        open.onclick = () => openProject(p, "action");
        open.className = "primary";
        actions.append(open);
        const remote = document.createElement("a");
        remote.href = `${gitlabUrl}/${p.path_with_namespace.split("/").map(encodeURIComponent).join("/")}`;
        remote.target = "_blank";
        remote.rel = "noopener noreferrer";
        remote.className = "repository-link";
        remote.append(icon("repository"), document.createTextNode("View in GitLab"));
        actions.append(remote);
        row.append(actions);
        section.append(row);
      }
    }
    setDashboardRefreshing(dashboardRefreshing);
    updateRepositoryTimes(lastRepositoriesRefresh);
  }
  return {
    render: renderCatalog,
    showLatestTag,
    showWorkspaceStatus,
    setRefreshing: setDashboardRefreshing,
    updateRepositoryTimes,
    installRefreshGuards() {
      for (const type of ["click", "auxclick", "keydown"]) {
        repos.addEventListener(
          type,
          (event) => {
            if (type === "keydown" && (event as KeyboardEvent).key !== "Enter") return;
            if (!(event.target as HTMLElement).closest('.repository-link[aria-disabled="true"]')) return;
            event.preventDefault();
            event.stopImmediatePropagation();
          },
          true,
        );
      }
    },
    installFilterControls() {
      topicFilters.onclick = (event) => {
        const chip = (event.target as HTMLElement).closest<HTMLElement>("button[data-project-topic]");
        if (!chip) return;
        const key = chip.dataset.projectTopic;
        if (!key) selectedProjectTopics.clear();
        else if (selectedProjectTopics.has(key)) selectedProjectTopics.delete(key);
        else selectedProjectTopics.add(key);
        requestRender();
      };
      search.oninput = requestRender;
      clearFilters.onclick = () => {
        search.value = "";
        selectedProjectTopics.clear();
        requestRender();
        search.focus({ preventScroll: true });
      };
      for (const button of sortButtons) {
        button.onclick = () => {
          const type = button.dataset.projectSort;
          projectSort = projectSort.startsWith(`${type}-`)
            ? `${type}-${projectSort.endsWith("-asc") ? "desc" : "asc"}`
            : `${type}-${type === "name" ? "asc" : "desc"}`;
          try {
            storage.setItem("aux-project-sort", projectSort);
          } catch (error) {
            console.warn("Could not save project sort preference", error);
          }
          syncProjectSort();
          requestRender();
        };
      }
    },
  };
}
