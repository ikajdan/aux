// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface PaneLayoutSettings { paneRatio?: number }

export function createWorkspaceLayout<T extends PaneLayoutSettings>(getSettings: () => T, setSettings: (settings: T) => void) {
  const grid = document.querySelector<HTMLElement>(".workspace-grid");
  const divider = document.getElementById("pane-divider");
  const sidebar = grid.querySelector<HTMLElement>(".files-pane");
  const sidebarHeading = sidebar.querySelector<HTMLElement>(".pane-heading");
  const sidebarSwitch = sidebarHeading.querySelector<HTMLElement>(".sidebar-tabs");
  function updateSidebarMinimum() {
    if (!sidebarSwitch.getClientRects().length) return;
    const measure = sidebarSwitch.cloneNode(true) as HTMLElement;
    measure.removeAttribute("id");
    for (const element of measure.querySelectorAll("[id]")) element.removeAttribute("id");
    measure.setAttribute("aria-hidden", "true");
    measure.inert = true;
    Object.assign(measure.style, {
      position: "absolute",
      visibility: "hidden",
      width: "max-content",
      minWidth: "max-content",
      maxWidth: "none",
    });
    sidebarHeading.append(measure);
    const headingStyle = getComputedStyle(sidebarHeading);
    const sidebarStyle = getComputedStyle(sidebar);
    const width =
      measure.getBoundingClientRect().width +
      parseFloat(headingStyle.paddingLeft) +
      parseFloat(headingStyle.paddingRight) +
      parseFloat(headingStyle.borderLeftWidth) +
      parseFloat(headingStyle.borderRightWidth) +
      parseFloat(sidebarStyle.borderLeftWidth) +
      parseFloat(sidebarStyle.borderRightWidth);
    measure.remove();
    grid.style.setProperty("--sidebar-min-width", `${Math.ceil(width)}px`);
  }
  new ResizeObserver(updateSidebarMinimum).observe(sidebarSwitch);
  document.fonts.ready.then(updateSidebarMinimum);
  document.fonts.addEventListener("loadingdone", updateSidebarMinimum);
  updateSidebarMinimum();
  let hasShownDividerHint = false;
  const editorPane = document.querySelector<HTMLElement>(".editor-pane");
  const previewPane = document.querySelector<HTMLElement>(".preview-pane");
  const desktopLayout = matchMedia("(min-width: 1101px)");
  const settings = getSettings();
  let paneRatio = Number.isFinite(settings.paneRatio) && settings.paneRatio >= 20 && settings.paneRatio <= 80 ? settings.paneRatio : 50;
  let resizePointer: number | undefined;
  function splitBounds() {
    const width = editorPane.getBoundingClientRect().width + previewPane.getBoundingClientRect().width;
    const min = width > 0 ? Math.min(50, Math.max(20, (240 / width) * 100)) : 20;
    return { width, min, max: 100 - min };
  }
  function applyPaneRatio() {
    if (!desktopLayout.matches) return;
    const { min, max } = splitBounds();
    const effective = Math.min(max, Math.max(min, paneRatio));
    grid.style.setProperty("--editor-share", `${effective}fr`);
    grid.style.setProperty("--preview-share", `${100 - effective}fr`);
    divider.setAttribute("aria-valuemin", String(Math.round(min)));
    divider.setAttribute("aria-valuemax", String(Math.round(max)));
    divider.setAttribute("aria-valuenow", String(Math.round(effective)));
  }
  function savePaneRatio() {
    const next = { ...getSettings(), paneRatio };
    try {
      localStorage.setItem("aux-settings", JSON.stringify(next));
      setSettings(next);
    } catch (error) {
      console.warn("Could not save pane layout", error);
    }
  }
  function finishPaneResize() {
    if (resizePointer === undefined) return;
    const pointer = resizePointer;
    resizePointer = undefined;
    document.body.classList.remove("resizing-panes");
    if (divider.hasPointerCapture(pointer)) divider.releasePointerCapture(pointer);
    savePaneRatio();
  }
  divider.addEventListener("pointerdown", (event) => {
    if (!desktopLayout.matches || event.button !== 0 || resizePointer !== undefined) return;
    event.preventDefault();
    divider.focus();
    divider.setPointerCapture(event.pointerId);
    resizePointer = event.pointerId;
    document.body.classList.add("resizing-panes");
  });
  divider.addEventListener("pointermove", (event) => {
    if (event.pointerId !== resizePointer) return;
    const { width, min, max } = splitBounds();
    if (!width) return;
    const left = editorPane.getBoundingClientRect().left;
    paneRatio = Math.min(max, Math.max(min, ((event.clientX - left - divider.offsetWidth / 2) / width) * 100));
    applyPaneRatio();
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    divider.addEventListener(name, (event) => {
      if (event.pointerId === resizePointer) finishPaneResize();
    });
  }
  divider.addEventListener("blur", finishPaneResize);
  window.addEventListener("blur", finishPaneResize);
  desktopLayout.addEventListener("change", () => {
    finishPaneResize();
    applyPaneRatio();
  });
  divider.addEventListener("keydown", (event) => {
    if (!desktopLayout.matches) return;
    const { min, max } = splitBounds();
    const current = Math.min(max, Math.max(min, paneRatio));
    const step = event.shiftKey ? 5 : 1;
    if (event.key === "ArrowLeft") paneRatio = Math.max(min, current - step);
    else if (event.key === "ArrowRight") paneRatio = Math.min(max, current + step);
    else if (event.key === "Home") paneRatio = min;
    else if (event.key === "End") paneRatio = max;
    else return;
    event.preventDefault();
    applyPaneRatio();
    savePaneRatio();
  });
  new ResizeObserver(applyPaneRatio).observe(grid);
  applyPaneRatio();
  return {
    showDividerHint() {
      if (hasShownDividerHint) return;
      hasShownDividerHint = true;
      divider.classList.add("handle-intro");
      setTimeout(() => divider.classList.remove("handle-intro"), 2500);
    },
  };
}
