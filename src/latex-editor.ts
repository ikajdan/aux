// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Extension } from "@codemirror/state";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { StreamLanguage, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { editorSearch, installEditorSearch, toggleEditorSearch } from "./editor-search.js";
import { latexSnippets } from "./latex-snippets.js";
import { snippetInsertion, formattingInsertion, type FormattingCommand } from "./snippet-insertion.js";
import { icon, type IconName } from "./ui-icons.js";
import { listContinuation } from "./latex-list-editing.js";

export function createEditor(parent: HTMLElement, onChange: (text: string) => void, onSelectionChange: () => void = () => {}) {
  const styleNonce = document.querySelector<HTMLMetaElement>('meta[name="csp-style-nonce"]')?.content || "";
  const access = new Compartment();
  const theme = new Compartment();
  const language = new Compartment();
  const languageExtension = (path: string): Extension => (/\.(tex|sty|cls)$/i.test(path) ? StreamLanguage.define(stex) : []);
  let currentPath = "";
  let readOnly = true;
  let busy = false;
  let deferBusyControls = false;
  let dark = false;
  let jumping = false;
  const snippetButtons: HTMLButtonElement[] = [];
  const snippetPopovers: HTMLElement[] = [];
  function closeSnippetPopovers() {
    for (const popover of snippetPopovers) if (popover.matches(":popover-open")) popover.hidePopover();
  }
  const snippetAvailable = () => !readOnly && /\.(tex|sty|cls|ltx)$/i.test(currentPath) && !parent.hidden;
  const canInsertSnippet = () => !busy && snippetAvailable();
  function updateSnippetButtons() {
    for (const button of snippetButtons) button.disabled = !snippetAvailable() || (busy && !deferBusyControls);
    if (!canInsertSnippet()) closeSnippetPopovers();
  }
  const accessExtensions = () => [
    EditorState.readOnly.of(readOnly || busy),
    EditorView.editable.of(!readOnly && !busy),
    EditorView.contentAttributes.of({ "aria-label": "File contents", "aria-readonly": String(readOnly || busy), spellcheck: "false" }),
  ];
  const themeExtension = () => EditorView.theme({}, { dark });
  const formatSelection =
    (command: FormattingCommand, wordAtCursor = false) =>
    (target: EditorView) => {
      if (!canInsertSnippet()) return false;
      const transaction = formattingInsertion(target.state, command, wordAtCursor);
      if (!transaction) return false;
      target.dispatch(transaction);
      return true;
    };
  const extensions = (path: string) => [
    EditorView.cspNonce.of(styleNonce),
    lineNumbers(),
    ...(path ? [highlightActiveLineGutter(), highlightActiveLine(), bracketMatching(), syntaxHighlighting(classHighlighter)] : []),
    drawSelection(),
    history(),
    editorSearch,
    indentOnInput(),
    indentUnit.of("    "),
    EditorState.tabSize.of(4),
    keymap.of([
      {
        key: "Enter",
        run: (target) => {
          if (!canInsertSnippet()) return false;
          const transaction = listContinuation(target.state);
          if (!transaction) return false;
          target.dispatch(transaction);
          return true;
        },
      },
      { key: "Mod-b", run: formatSelection("textbf", true) },
      { key: "Mod-i", run: formatSelection("emph", true) },
      { key: "Mod-Shift-x", run: formatSelection("texttt", true) },
      { key: "Mod-Shift-m", run: formatSelection("display-math") },
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    placeholder("Choose a file from the file tree to start editing."),
    language.of(languageExtension(path)),
    access.of(accessExtensions()),
    theme.of(themeExtension()),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString());
      if (!jumping && !busy && currentPath && update.view.hasFocus && (update.selectionSet || update.docChanged)) {
        const head = update.state.selection.main.head;
        const previous = update.startState.selection.main.head;
        const line = update.state.doc.lineAt(head);
        const oldLine = update.startState.doc.lineAt(previous);
        if (line.number !== oldLine.number || head - line.from !== previous - oldLine.from) onSelectionChange();
      }
    }),
  ];
  const view = new EditorView({ parent, state: EditorState.create({ extensions: extensions("") }) });
  const pane = parent.closest<HTMLElement>(".editor-pane") || parent;
  installEditorSearch(view, pane);
  const snippetActions = pane.querySelector("#latex-snippets");
  if (snippetActions) {
    const groups = new Map<string, HTMLElement>();
    const groupDefinitions: { label: string; icon: IconName }[] = [
      { label: "Text formatting", icon: "bold" },
      { label: "Headings", icon: "section" },
      { label: "Lists", icon: "list-bullets" },
      { label: "Figures, tables and code", icon: "image" },
      { label: "Callout blocks", icon: "note" },
    ];
    for (const [index, definition] of groupDefinitions.entries()) {
      const { label } = definition;
      const group = document.createElement("div");
      group.id = `snippet-popover-${index}`;
      group.className = "snippet-popover";
      group.popover = "auto";
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", label);
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.title = `Insert ${label.toLowerCase()}`;
      trigger.setAttribute("aria-label", label);
      trigger.setAttribute("aria-controls", group.id);
      trigger.setAttribute("aria-expanded", "false");
      trigger.append(icon(definition.icon));
      trigger.popoverTargetElement = group;
      trigger.popoverTargetAction = "toggle";
      group.addEventListener("beforetoggle", (event) => {
        if ((event as ToggleEvent).newState !== "open") return;
        if (!canInsertSnippet()) {
          event.preventDefault();
          return;
        }
        group.style.visibility = "hidden";
        // Keep it hidden until the native open step has made its size measurable.
        requestAnimationFrame(() => {
          if (!group.matches(":popover-open")) return;
          const anchor = trigger.getBoundingClientRect();
          const bounds = group.getBoundingClientRect();
          const gap = 8;
          group.style.left = `${Math.max(gap, Math.min(anchor.left, innerWidth - bounds.width - gap))}px`;
          group.style.top = `${Math.max(gap, anchor.bottom + bounds.height + gap <= innerHeight ? anchor.bottom + gap : anchor.top - bounds.height - gap)}px`;
          group.style.visibility = "";
          group.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
        });
      });
      group.addEventListener("toggle", () => {
        trigger.setAttribute("aria-expanded", String(group.matches(":popover-open")));
      });
      group.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        group.hidePopover();
        trigger.focus();
      });
      snippetButtons.push(trigger);
      snippetPopovers.push(group);
      groups.set(label, group);
      snippetActions.append(trigger, group);
    }
    const formattingActions: { command: FormattingCommand; label: string; icon: IconName }[] = [
      { command: "textbf", label: "Bold", icon: "bold" },
      { command: "emph", label: "Italic", icon: "italic" },
      { command: "texttt", label: "Monospace", icon: "code-listing" },
      { command: "display-math", label: "Display math", icon: "math" },
      { command: "section", label: "Section heading", icon: "section" },
      { command: "subsection", label: "Subsection heading", icon: "subsection" },
      { command: "subsubsection", label: "Subsubsection heading", icon: "subsubsection" },
    ];
    for (const action of formattingActions) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.format = action.command;
      button.setAttribute("aria-label", action.label);
      button.title = `Insert ${action.label.toLowerCase()}`;
      button.append(icon(action.icon), document.createTextNode(action.label));
      button.onclick = () => {
        if (!canInsertSnippet()) return;
        const transaction = formattingInsertion(view.state, action.command);
        if (!transaction) return;
        closeSnippetPopovers();
        view.dispatch(transaction);
        view.focus();
      };
      snippetButtons.push(button);
      groups.get(["section", "subsection", "subsubsection"].includes(action.command) ? "Headings" : "Text formatting").append(button);
    }
    for (const snippet of latexSnippets) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.snippet = snippet.id;
      button.setAttribute("aria-label", `Insert ${snippet.label}`);
      button.title = `Insert ${snippet.label.toLowerCase()}`;
      button.append(icon(snippet.icon), document.createTextNode(snippet.label));
      button.onclick = () => {
        if (!canInsertSnippet()) return;
        const transaction = snippetInsertion(view.state, snippet.text, snippet.cursorOffset);
        if (!transaction) return;
        closeSnippetPopovers();
        view.dispatch(transaction);
        view.focus();
      };
      snippetButtons.push(button);
      const group = ["note", "warning", "important"].includes(snippet.id)
        ? "Callout blocks"
        : ["itemize", "enumerate"].includes(snippet.id)
          ? "Lists"
          : "Figures, tables and code";
      groups.get(group).append(button);
    }
    updateSnippetButtons();
  }
  return {
    toggleSearch: () => (currentPath && !parent.hidden ? toggleEditorSearch(view) : false),
    getText: () => view.state.doc.toString(),
    getPath: () => currentPath,
    ensureFinalNewline() {
      if (!currentPath || readOnly || parent.hidden) return;
      const end = view.state.doc.length;
      if (end && view.state.doc.sliceString(end - 1, end) !== "\n") {
        view.dispatch({ changes: { from: end, insert: "\n" }, selection: view.state.selection });
      }
    },
    canEdit: () => Boolean(currentPath) && !readOnly && !parent.hidden,
    hasFocus: () => view.hasFocus,
    getCursor() {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return { line: line.number, column: head - line.from + 1 };
    },
    goToLine(number: number, column = 1) {
      const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, number)));
      const anchor = line.from + Math.max(0, Math.min(line.length, column - 1));
      jumping = true;
      try {
        view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
        view.focus();
      } finally {
        jumping = false;
      }
    },
    // A fresh state avoids treating file loads as edits and prevents undo across files.
    setText(text = "", path = "") {
      currentPath = path;
      view.setState(EditorState.create({ doc: text, extensions: extensions(path) }));
      updateSnippetButtons();
    },
    setPath(path: string) {
      currentPath = path;
      view.dispatch({ effects: language.reconfigure(languageExtension(path)) });
      updateSnippetButtons();
    },
    setReadOnly(value: boolean) {
      readOnly = Boolean(value);
      view.dispatch({ effects: access.reconfigure(accessExtensions()) });
      updateSnippetButtons();
    },
    setBusy(value: boolean, deferControls = false) {
      busy = Boolean(value);
      deferBusyControls = busy && deferControls;
      view.dispatch({ effects: access.reconfigure(accessExtensions()) });
      updateSnippetButtons();
    },
    setTheme(value: string) {
      dark = value === "dark";
      view.dispatch({ effects: theme.reconfigure(themeExtension()) });
    },
    focus: () => {
      if (parent.hidden) return;
      view.requestMeasure();
      view.focus();
    },
  };
}
