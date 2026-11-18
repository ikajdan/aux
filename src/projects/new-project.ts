// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ApplicationProject } from "../application.js";
import type { GitLabAPI } from "../gitlab-sync.js";
import type { ServerConfig } from "../server-config.js";
import { createSelect } from "../select-control.js";
import { promptDialog, restoreFocus } from "../modal-dialogs.js";
import { prepareTemplateProject } from "./template-project.js";

export function initializeNewProject({
  api,
  config,
  getToken,
  onCreated,
  onReady,
}: {
  api: GitLabAPI;
  config: ServerConfig;
  getToken: () => string;
  onCreated: (project: ApplicationProject) => void;
  onReady: () => Promise<unknown>;
}) {
  const button = document.getElementById("new-project") as HTMLButtonElement;
  document.getElementById("new-project-card").hidden = !config.templateRepository;
  if (!config.templateRepository) return;

  const dialog = document.getElementById("new-project-dialog") as HTMLDialogElement;
  const form = document.getElementById("new-project-form") as HTMLFormElement;
  const name = document.getElementById("new-project-name") as HTMLInputElement;
  const path = document.getElementById("new-project-path") as HTMLInputElement;
  const namespace = document.getElementById("new-project-namespace") as HTMLSelectElement;
  const submit = document.getElementById("create-project") as HTMLButtonElement;
  const close = document.getElementById("new-project-close") as HTMLButtonElement;
  const feedback = document.getElementById("new-project-status") as HTMLParagraphElement;
  const resultLink = document.getElementById("new-project-result") as HTMLAnchorElement;

  const projectURL = (projectPath: string) => `${config.gitlabUrl}/${projectPath.split("/").map(encodeURIComponent).join("/")}`;

  for (const group of config.repositoryGroups) {
    const option = document.createElement("option");
    option.value = group.path;
    option.textContent = `${group.name} (${group.path})`;
    namespace.append(option);
  }
  const customNamespace = document.createElement("option");
  customNamespace.value = ":custom-namespace";
  customNamespace.textContent = "Other namespace…";
  customNamespace.dataset.separator = "true";
  namespace.append(customNamespace);
  const namespaceSelect = createSelect(namespace);
  let selectedNamespace = "";
  let choosingNamespace = false;
  let submitting = false;
  let created: ApplicationProject | null = null;

  let uncertain = false;
  let dialogSession = 0;
  let validationFailed = false;
  let userCache: { token: string; request: Promise<{ username: string }> } | undefined;

  function getUser() {
    const token = getToken();
    if (userCache?.token === token) return userCache.request;
    const entry = { token, request: api.request<{ username: string }>("user") };
    userCache = entry;
    void entry.request.catch(() => {
      if (userCache === entry) userCache = undefined;
    });
    return entry.request;
  }

  namespace.onchange = async () => {
    if (namespace.value !== customNamespace.value) {
      selectedNamespace = namespace.value;
      return;
    }
    namespaceSelect.setValue(selectedNamespace);
    if (choosingNamespace || submitting) return;
    choosingNamespace = true;
    const session = dialogSession;
    const token = getToken();
    try {
      const value = await promptDialog("Enter an existing group or subgroup path where you can create projects. This does not create a namespace.", {
        title: "Other namespace",
        label: "Namespace path",
        confirmLabel: "Use namespace",
        icon: "repository",
      });
      if (!value?.trim() || !dialog.open || session !== dialogSession || token !== getToken()) return;
      const destination = value.trim();
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/.test(destination)) {
        throw new Error("Use a group or subgroup path, such as team/documents.");
      }
      const user = await getUser();
      if (!dialog.open || session !== dialogSession || token !== getToken()) return;
      if (destination.toLowerCase() === user.username.toLowerCase()) {
        selectedNamespace = "";
      } else {
        const existing = [...namespace.options].find((option) => option.value.toLowerCase() === destination.toLowerCase());
        if (existing) selectedNamespace = existing.value;
        else {
          const option = document.createElement("option");
          option.value = option.textContent = destination;
          namespace.insertBefore(option, customNamespace);
          selectedNamespace = destination;
        }
      }
      namespaceSelect.setValue(selectedNamespace);
      namespaceSelect.rebuild();
    } catch (error) {
      if (dialog.open && session === dialogSession && token === getToken()) {
        feedback.dataset.state = "error";
        feedback.textContent = error.message;
      }
    } finally {
      choosingNamespace = false;
    }
  };

  function clearValidation() {
    for (const field of [name, path]) {
      if (field.validity.valid) field.removeAttribute("aria-invalid");
    }
    if (validationFailed && name.validity.valid && path.validity.valid) {
      feedback.textContent = "";
      delete feedback.dataset.state;
      validationFailed = false;
    }
  }

  name.addEventListener("input", () => {
    path.value = name.value
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    clearValidation();
  });
  path.addEventListener("input", () => {
    name.value = path.value;
    clearValidation();
  });
  button.onclick = async () => {
    if (dialog.open) return;
    const session = ++dialogSession;
    const token = getToken();
    form.reset();
    validationFailed = false;
    delete feedback.dataset.state;
    name.removeAttribute("aria-invalid");
    path.removeAttribute("aria-invalid");
    namespace.options[0].textContent = "My namespace";
    namespaceSelect.rebuild();

    created = null;
    uncertain = false;
    feedback.textContent = "";
    resultLink.hidden = true;
    submit.disabled = false;
    submit.textContent = "Create project";
    selectedNamespace = "";
    namespaceSelect.setValue("");
    dialog.showModal();
    name.focus();
    try {
      const user = await getUser();
      if (!dialog.open || session !== dialogSession || token !== getToken()) return;
      if (user.username) {
        namespace.options[0].textContent = user.username;
        namespaceSelect.rebuild();
      }
    } catch (error) {
      if (dialog.open && session === dialogSession && token === getToken() && !submitting && !created && !validationFailed) {
        feedback.textContent = `Could not load your namespace. ${error.message}`;
      }
    }
  };
  document.getElementById("new-project-title-action").onclick = () => button.click();
  dialog.addEventListener("cancel", (event) => {
    if (submitting) event.preventDefault();
  });
  dialog.addEventListener("close", () => restoreFocus(button));

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (submitting || created || uncertain || choosingNamespace) return;
    name.value = name.value.trim();
    path.value = path.value.trim();
    const invalid = [name, path].filter((field) => !field.validity.valid);
    for (const field of [name, path]) {
      if (invalid.includes(field)) field.setAttribute("aria-invalid", "true");
      else field.removeAttribute("aria-invalid");
    }
    if (invalid.length) {
      validationFailed = true;
      feedback.dataset.state = "error";
      feedback.textContent = invalid[0] === name ? "Enter a project name." : path.validity.valueMissing ? "Enter a project path." : "Invalid project path.";
      invalid[0].focus();
      return;
    }
    validationFailed = false;
    delete feedback.dataset.state;
    submitting = true;
    close.disabled = true;
    submit.disabled = true;
    name.disabled = path.disabled = namespace.disabled = true;
    namespaceSelect.sync();
    feedback.textContent = "Reading template…";
    let creationRequested = false;
    try {
      const template = await prepareTemplateProject(api, config, (progress) => {
        feedback.textContent = progress.phase === "downloading" ? `Reading template… (${progress.files} files)` : "Reading template…";
      });
      const destination = namespace.value ? await api.request<{ id: number }>(`groups/${encodeURIComponent(namespace.value)}`) : null;
      const destinationPath = namespace.value || (await getUser()).username;
      resultLink.href = projectURL(`${destinationPath}/${path.value}`);
      feedback.textContent = "Creating project…";
      creationRequested = true;
      created = await api.request<ApplicationProject>("projects", {
        name: name.value,
        path: path.value,
        visibility: template.visibility,
        default_branch: template.branch,
        initialize_with_readme: false,
        ...(destination ? { namespace_id: destination.id } : {}),
      });
      if (!created?.id || !created.path_with_namespace) throw new Error("GitLab returned an incomplete project response. Check GitLab before trying again.");
      resultLink.href = projectURL(created.path_with_namespace);
      resultLink.hidden = false;
      submit.textContent = "Project created";
      feedback.textContent = "Copying template files…";
      await api.request(`projects/${encodeURIComponent(created.id)}/repository/commits`, template.commit);
      created.default_branch = template.branch;
      onCreated(created);
      await onReady();
      feedback.textContent = "Project created and added to Documents.";
    } catch (error) {
      uncertain = creationRequested && !created && (!error.status || error.status >= 500);
      if (uncertain) {
        resultLink.hidden = false;
        feedback.textContent =
          "GitLab may have created the project, but its response could not be confirmed. Check the project link before starting another creation.";
      } else {
        feedback.textContent = created
          ? `The project was created, but setup could not finish. ${error.message} Check it using the GitLab link.`
          : `Could not create project. ${error.message}`;
      }
    } finally {
      submitting = false;
      close.disabled = false;
      name.disabled = path.disabled = namespace.disabled = false;
      submit.disabled = Boolean(created) || uncertain;
      namespaceSelect.sync();
    }
  };
}
