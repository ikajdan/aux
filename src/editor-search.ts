// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Panel } from "@codemirror/view";
import type { IconName } from "./ui-icons.js";
import { EditorView } from "@codemirror/view";
import {
  SearchQuery,
  search,
  getSearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  openSearchPanel,
  closeSearchPanel,
  searchPanelOpen,
} from "@codemirror/search";
import { icon } from "./ui-icons.js";

const panelIds = new WeakMap<EditorView, string>();
let nextPanelId = 0;

export function editorSearchPanelId(view: EditorView) {
  if (!panelIds.has(view)) panelIds.set(view, `editor-find-${++nextPanelId}`);
  return panelIds.get(view);
}

function focusEditorSearch(view: EditorView, replace = false) {
  const previousQuery = getSearchQuery(view.state);
  view.dom.querySelector(".editor-find")?.dispatchEvent(new Event("reopen-search"));
  const opened = openSearchPanel(view);
  const query = getSearchQuery(view.state);
  if (query.replace !== previousQuery.replace || query.caseSensitive !== previousQuery.caseSensitive) {
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ ...query, replace: previousQuery.replace, caseSensitive: previousQuery.caseSensitive })) });
  }
  if (replace) {
    const input = view.dom.querySelector<HTMLInputElement>('.editor-find input[name="replace"]');
    input?.focus({ preventScroll: true });
    input?.select();
  }
  return opened;
}

export function toggleEditorSearch(view: EditorView) {
  if (!searchPanelOpen(view.state)) return focusEditorSearch(view);
  closeSearchPanel(view);
  view.focus();
  return true;
}

export { searchPanelOpen };

function createPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "document-find editor-find";
  dom.id = editorSearchPanelId(view);
  dom.setAttribute("role", "search");
  const content = document.createElement("div");
  content.className = "document-find-content";
  const input = document.createElement("input");
  input.type = "search";
  input.name = "search";
  input.setAttribute("main-field", "true");
  input.placeholder = "Search file…";
  input.setAttribute("aria-label", "Find in editor");
  input.autocomplete = "off";
  input.spellcheck = false;
  input.value = getSearchQuery(view.state).search;
  const searchField = document.createElement("div");
  searchField.className = "editor-find-field";
  const matchCase = document.createElement("button");
  matchCase.type = "button";
  matchCase.className = "editor-find-case";
  matchCase.append(icon("match-case"));
  matchCase.title = "Match case";
  matchCase.setAttribute("aria-label", "Match case");
  matchCase.setAttribute("aria-pressed", String(getSearchQuery(view.state).caseSensitive));
  matchCase.onclick = () => {
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ ...getSearchQuery(view.state), caseSensitive: !getSearchQuery(view.state).caseSensitive })) });
    recount();
  };
  searchField.append(input, matchCase);
  const replacementContent = document.createElement("div");
  replacementContent.className = "document-find-content editor-find-replacement";
  const replacement = document.createElement("input");
  replacement.type = "text";
  replacement.name = "replace";
  replacement.placeholder = "Replace with…";
  replacement.setAttribute("aria-label", "Replace with");
  replacement.autocomplete = "off";
  replacement.spellcheck = false;
  replacement.value = getSearchQuery(view.state).replace;
  const count = document.createElement("span");
  count.className = "document-find-count";
  count.setAttribute("role", "status");
  count.setAttribute("aria-live", "polite");
  count.setAttribute("aria-atomic", "true");
  function button(label: string, image: IconName, action: () => void) {
    const element = document.createElement("button");
    element.type = "button";
    element.title = label;
    element.setAttribute("aria-label", label);
    element.append(icon(image));
    element.onclick = action;
    return element;
  }
  const previous = button("Find previous", "arrow-up", () => findPrevious(view));
  const next = button("Find next", "arrow-down", () => findNext(view));
  previous.className = next.className = "editor-find-navigation";
  previous.append(document.createTextNode("Previous"));
  next.append(document.createTextNode("Next"));
  function replaceButton(label: string, image: IconName, action: typeof replaceNext) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "editor-find-replace-action";
    element.append(icon(image), document.createTextNode(label));
    element.onclick = () => {
      if (view.state.readOnly) return;
      action(view);
      recount();
    };
    return element;
  }
  const replaceOne = replaceButton("Replace next", "replace-next", replaceNext);
  const replaceEvery = replaceButton("Replace all", "replace-all", replaceAll);
  const replacementActions = document.createElement("div");
  replacementActions.className = "editor-find-actions";
  replacementActions.append(replaceOne, replaceEvery);
  replacementContent.append(replacement, replacementActions);
  let timer: ReturnType<typeof setTimeout>;
  let animation: Animation;
  let closing = false;
  let matches: { from: number; to: number }[] = [];
  function animate(open: boolean) {
    const height = dom.getBoundingClientRect().height;
    animation?.cancel();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !dom.animate) return null;
    return dom.animate(
      [
        { height: `${open ? 0 : height}px`, opacity: open ? 0 : 1, transform: open ? "translateY(-6px)" : "translateY(0)" },
        { height: `${open ? dom.scrollHeight : 0}px`, opacity: open ? 1 : 0, transform: open ? "translateY(0)" : "translateY(-6px)" },
      ],
      { duration: open ? 200 : 150, easing: "ease-out" },
    );
  }
  function close() {
    if (closing) return;
    closing = true;
    dom.inert = true;
    view.focus();
    animation = animate(false);
    if (animation) animation.onfinish = () => closeSearchPanel(view);
    else closeSearchPanel(view);
  }
  dom.addEventListener("reopen-search", () => {
    closing = false;
    dom.inert = false;
    animation?.cancel();
  });
  const closeButton = button("Close search", "close", close);
  closeButton.className = "editor-find-close";
  const searchActions = document.createElement("div");
  searchActions.className = "editor-find-actions";
  searchActions.append(previous, next, count, closeButton);
  content.append(searchField, searchActions);
  dom.append(content, replacementContent);
  function showCount() {
    const selected = view.state.selection.main;
    const active = matches.findIndex((match) => match.from === selected.from && match.to === selected.to);
    count.textContent = input.value ? `${active + 1} of ${matches.length}` : "";
    previous.disabled = next.disabled = !matches.length;
    replacement.disabled = view.state.readOnly;
    replaceOne.disabled = replaceEvery.disabled = view.state.readOnly || !matches.length;
  }
  function recount() {
    clearTimeout(timer);
    matches = [];
    const query = getSearchQuery(view.state);
    if (query.valid) {
      const cursor = query.getCursor(view.state.doc);
      for (let result = cursor.next(); !result.done; result = cursor.next()) {
        matches.push({ from: result.value.from, to: result.value.to });
      }
    }
    showCount();
  }
  function scheduleCount() {
    clearTimeout(timer);
    previous.disabled = next.disabled = replaceOne.disabled = replaceEvery.disabled = true;
    replacement.disabled = view.state.readOnly;
    count.textContent = input.value ? "Searching…" : "";
    timer = setTimeout(recount, 120);
  }
  input.oninput = replacement.oninput = () => {
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: input.value,
          replace: replacement.value,
          caseSensitive: getSearchQuery(view.state).caseSensitive,
          literal: true,
          regexp: false,
        }),
      ),
    });
  };
  dom.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && event.target === input) {
      event.preventDefault();
      recount();
      (event.shiftKey ? findPrevious : findNext)(view);
    }
  });
  return {
    dom,
    top: true,
    mount() {
      animation = animate(true);
      input.focus({ preventScroll: true });
      input.select();
      recount();
    },
    update(update) {
      const query = getSearchQuery(update.state);
      if (update.docChanged || !query.eq(getSearchQuery(update.startState))) {
        input.value = query.search;
        replacement.value = query.replace;
        matchCase.setAttribute("aria-pressed", String(query.caseSensitive));
        scheduleCount();
      } else if (update.selectionSet || update.state.readOnly !== update.startState.readOnly) showCount();
    },
    destroy() {
      clearTimeout(timer);
      animation?.cancel();
    },
  };
}

export const editorSearch = search({
  top: true,
  literal: true,
  caseSensitive: false,
  createPanel,
  scrollToMatch: (range) => EditorView.scrollIntoView(range, { y: "center" }),
});

export function installEditorSearch(view: EditorView, pane: HTMLElement) {
  pane.addEventListener(
    "keydown",
    (event) => {
      if (view.dom.parentElement.hidden || event.isComposing || (event.target as Element).closest("dialog")) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && ["f", "h"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        event.stopPropagation();
        focusEditorSearch(view, event.key.toLowerCase() === "h");
      } else if (event.key === "Escape" && searchPanelOpen(view.state) && !(event.target as Element).closest(".editor-find")) {
        event.preventDefault();
        event.stopPropagation();
        closeSearchPanel(view);
        view.focus();
      }
    },
    true,
  );
}
