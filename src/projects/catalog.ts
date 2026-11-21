// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ApplicationProject, Settings, StatusState } from "../application-types.js";
import type { createCatalogView } from "./catalog-view.js";
import { repositoryGroupFor, fetchGroupRepositories, type RepositoryGroup } from "./repository-groups.js";
import { parseCustomRepositories, customRepositoryMatches, groupCatalogRepositories, fetchCustomRepositories } from "./custom-repositories.js";

export interface CatalogOptions {
  initialProjects: ApplicationProject[];
  config: { gitlabUrl: string; repositoryGroups: RepositoryGroup[] };
  api: {
    request: (endpoint: string) => Promise<unknown>;
    pages: <T>(endpoint: string) => Promise<T[]>;
  };
  view: Pick<ReturnType<typeof createCatalogView>, "showLatestTag" | "updateRepositoryTimes" | "setRefreshing" | "installRefreshGuards" | "render">;
  elements: {
    refresh: HTMLElement;
    customRepositories: HTMLTextAreaElement;
    customRepositoriesStatus: HTMLElement;
  };
  getToken: () => string;
  getSettings: () => Settings;
  setSettings: (settings: Settings) => void;
  storage: Pick<Storage, "setItem">;
  readStorage: (key: string) => string | null;
  status: (message: string, state: StatusState) => void;
  dismissStatus: () => void;
  getStatusVersion: () => number;
}

export function isAvailableProject(project: ApplicationProject) {
  return !(
    project.pending_delete ||
    project.marked_for_deletion_at ||
    project.marked_for_deletion_on ||
    [project.name, project.path, project.path_with_namespace].some((value) => /-deletion_scheduled-\d+$/i.test(value || ""))
  );
}

export function createCatalogController(options: CatalogOptions) {
  const {
    initialProjects,
    config: serverConfig,
    api,
    view: catalogView,
    elements,
    getToken,
    getSettings,
    setSettings,
    storage,
    readStorage,
    status,
    dismissStatus,
    getStatusVersion,
  } = options;
  let catalog = initialProjects;
  let customRepositories: string[] = [];
  try {
    customRepositories = parseCustomRepositories((getSettings().customRepositories || []).join("\n"), serverConfig.gitlabUrl);
  } catch {
    // Ignore invalid cached paths rather than blocking startup.
  }
  let catalogGeneration = 0;
  let documentsRefresh: Promise<void> | null = null;
  let tagQueue = Promise.resolve();
  let lastRepositoriesRefresh = Number(readStorage("aux-last-repositories-refresh"));
  let uiInstalled = false;

  function showLatestTag(p: ApplicationProject) {
    catalogView.showLatestTag(p);
  }
  function fetchCatalogTags(generation: number, progress?: (completed: number, total: number) => void, { refreshAll = false } = {}) {
    const projects = catalog.filter((p) => isAvailableProject(p) && (refreshAll || p.latestTag === undefined));
    const token = getToken();
    if (!token.trim()) return Promise.resolve();
    // Drain superseded requests before starting another pool, keeping the total at four.
    tagQueue = tagQueue
      .catch(() => {})
      .then(async () => {
        let next = 0;
        let completed = 0;
        const current = () => generation === catalogGeneration && token === getToken();
        async function worker() {
          while (current() && next < projects.length) {
            const p = projects[next++];
            try {
              const endpoint = `projects/${encodeURIComponent(p.id)}/repository/tags`;
              let tags: unknown;
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
        if (current()) storage.setItem("aux-projects", JSON.stringify(catalog));
      });
    return tagQueue;
  }
  function updateRepositoryTimes() {
    catalogView.updateRepositoryTimes(lastRepositoriesRefresh);
  }

  function setDashboardRefreshing(refreshing: boolean) {
    catalogView.setRefreshing(refreshing);
  }

  function renderCatalog() {
    catalog = catalog.filter(
      (project) =>
        isAvailableProject(project) && (repositoryGroupFor(project, serverConfig.repositoryGroups) || customRepositoryMatches(project, customRepositories)),
    );
    catalogView.render(catalog, customRepositories, lastRepositoriesRefresh);
  }
  async function saveCustomRepositories() {
    const input = elements.customRepositories;
    const feedback = elements.customRepositoriesStatus;
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
    const next = { ...getSettings(), customRepositories: paths };
    try {
      storage.setItem("aux-settings", JSON.stringify(next));
    } catch {
      feedback.textContent = "Could not save repositories in this browser. Try again.";
      throw new Error(feedback.textContent);
    }
    setSettings(next);
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
    const refresh = elements.refresh;
    refresh.setAttribute("aria-busy", "true");
    refresh.dataset.loading = "true";
    const generation = ++catalogGeneration;
    setDashboardRefreshing(true);
    const token = getToken();
    const current = () => generation === catalogGeneration && token === getToken();
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
      storage.setItem("aux-projects", JSON.stringify(catalog));
      lastRepositoriesRefresh = Date.now();
      storage.setItem("aux-last-repositories-refresh", String(lastRepositoriesRefresh));
      updateRepositoryTimes();
      renderCatalog();
      await fetchCatalogTags(
        generation,
        background
          ? undefined
          : (done, total) => {
              if (!current()) return;
              status(`Retrieving version tags: ${done}/${total}…`, "busy");
              progressVersion = getStatusVersion();
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
      if (progressVersion !== undefined && progressVersion === getStatusVersion()) dismissStatus();
      if (documentsRefresh === pending) {
        documentsRefresh = null;
        setDashboardRefreshing(false);
        refresh.setAttribute("aria-busy", "false");
        delete refresh.dataset.loading;
      }
    });
  }

  function installUI() {
    if (uiInstalled) return;
    uiInstalled = true;
    updateRepositoryTimes();
    setInterval(updateRepositoryTimes, 60000);
    catalogView.installRefreshGuards();
  }

  return {
    get projects() {
      return catalog;
    },
    get customRepositories() {
      return customRepositories;
    },
    get isRefreshing() {
      return documentsRefresh !== null;
    },
    replaceCustomRepositories(paths: string[]) {
      customRepositories = paths;
    },
    addProject(created: ApplicationProject) {
      catalog = [...catalog.filter((entry) => String(entry.id) !== String(created.id)), created];
    },
    installUI,
    fetchCatalogTags,
    updateRepositoryTimes,
    setDashboardRefreshing,
    renderCatalog,
    saveCustomRepositories,
    refreshDocuments,
  };
}
