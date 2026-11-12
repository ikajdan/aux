// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readStorage } from "./browser-storage.js";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api.js";
import type { PageViewport } from "pdfjs-dist/types/src/display/display_utils.js";
import type { TextLayer as PDFTextLayer } from "pdfjs-dist";

export interface SourcePosition {
  page: number;
  x: number;
  y: number;
}
export interface PreviewPosition extends SourcePosition {
  width: number;
  height: number;
}
interface MatchPart {
  item: number;
  start: number;
  end: number;
}
interface PreviewMatch {
  page: number;
  parts: MatchPart[];
}
interface PreviewPage {
  number: number;
  element: HTMLDivElement;
  canvas: HTMLCanvasElement;
  text: HTMLDivElement;
  highlights: HTMLDivElement;
  viewport: PageViewport;
  layer: PDFTextLayer;
  baseWidth: number;
  ratio: number;
  rendered: boolean;
}
export interface Preview {
  openSearch(): void;
  toggleSearch(): void;
  setSyncEnabled(value: boolean): void;
  goToPosition(position: PreviewPosition): boolean;
  reset(): Promise<void>;
  show(blob: Blob, signal?: AbortSignal): Promise<void>;
}

import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist/build/pdf.mjs";

GlobalWorkerOptions.workerSrc = "/assets/pdfjs/pdf.worker.min.mjs";

export function createPreview(
  container: HTMLElement,
  empty: HTMLElement,
  report: (message: string, state: "error" | "busy" | "ready") => void,
  onSourceRequest: (position: SourcePosition) => void = () => {},
): Preview {
  let generation = 0,
    task: PDFDocumentLoadingTask,
    document: PDFDocumentProxy,
    observer: IntersectionObserver,
    renderTask: RenderTask,
    timer: ReturnType<typeof setTimeout>;
  let loadGeneration = 0;
  let cancelPending: () => Promise<void>;
  let pages: PreviewPage[] = [],
    visible = new Set<PreviewPage>(),
    width = 0,
    running = false;
  const ui = <T extends HTMLElement = HTMLElement>(id: string) => window.document.getElementById(id) as T;
  const panel = container?.closest<HTMLElement>("#preview-panel");

  const bar = ui("pdf-find");
  const input = ui<HTMLInputElement>("pdf-find-input");

  const count = ui("pdf-find-count");
  const previous = ui<HTMLButtonElement>("pdf-find-prev");
  const next = ui<HTMLButtonElement>("pdf-find-next");
  const close = ui<HTMLButtonElement>("pdf-find-close");
  const controlIds = [
    "pdf-controls",
    "pdf-page-prev",
    "pdf-page-number",
    "pdf-page-count",
    "pdf-page-next",
    "pdf-zoom-out",
    "pdf-zoom-value",
    "pdf-zoom-in",
    "pdf-fit-width",
    "pdf-invert-colors",
  ];
  const controls = Object.fromEntries(controlIds.map((id) => [id, ui(id)])) as Record<string, HTMLElement> & {
    "pdf-page-number": HTMLInputElement;
    "pdf-page-prev": HTMLButtonElement;
    "pdf-page-next": HTMLButtonElement;
    "pdf-zoom-out": HTMLButtonElement;
    "pdf-zoom-in": HTMLButtonElement;
  };
  const required = {
    ...controls,
    pdf: container,
    "preview-empty": empty,
    "preview-panel": panel,
    "pdf-find": bar,
    "pdf-find-input": input,

    "pdf-find-count": count,
    "pdf-find-prev": previous,
    "pdf-find-next": next,
    "pdf-find-close": close,
  };
  const invalid = Object.entries(required)
    .filter(([, element]) => !element || !panel?.contains(element))
    .map(([id]) => `#${id}`);

  if (invalid.length) {
    const error = new Error(`PDF preview unavailable: missing or misplaced ${invalid.join(", ")}`);
    console.error(error);
    if (empty) empty.textContent = error.message;

    return {
      openSearch() {},
      toggleSearch() {},
      setSyncEnabled() {},
      goToPosition() {
        return false;
      },
      async reset() {},
      async show() {
        report(error.message, "error");
        throw error;
      },
    };
  }
  let syncEnabled = false;
  let syncTimer: ReturnType<typeof setTimeout>;
  let pointerStart: { x: number; y: number; id: number; page: HTMLElement; dragged: boolean } = null;
  function setSyncEnabled(value: boolean) {
    syncEnabled = Boolean(value) && Boolean(document);
    container.classList.toggle("synctex-picking", syncEnabled);
    pointerStart = null;
  }
  container.addEventListener("pointerdown", (event) => {
    pointerStart =
      syncEnabled && event.button === 0
        ? { x: event.clientX, y: event.clientY, id: event.pointerId, page: (event.target as Element).closest<HTMLElement>(".pdf-page"), dragged: false }
        : null;
  });
  container.addEventListener("pointermove", (event) => {
    if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5) pointerStart.dragged = true;
  });
  container.addEventListener("pointercancel", () => {
    pointerStart = null;
  });
  container.addEventListener("pointerup", (event) => {
    const start = pointerStart;
    pointerStart = null;
    if (
      !syncEnabled ||
      !start ||
      start.dragged ||
      event.button !== 0 ||
      start.id !== event.pointerId ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5
    )
      return;
    const element = (event.target as Element).closest<HTMLElement>(".pdf-page");
    const page = pages[Number(element?.dataset.page) - 1];
    if (!page || element !== start.page) return;
    const rect = element.getBoundingClientRect();
    const [x, y] = page.viewport.convertToPdfPoint(
      ((event.clientX - rect.left) * page.viewport.width) / rect.width,
      ((event.clientY - rect.top) * page.viewport.height) / rect.height,
    );
    onSourceRequest({ page: page.number, x, y: page.viewport.viewBox[3] - y });
  });
  function goToPosition(position: PreviewPosition) {
    const page = pages[position.page - 1];
    if (!page || !goToPage(position.page)) return false;
    const top = page.viewport.viewBox[3];
    const box = page.viewport.convertToViewportRectangle([
      position.x,
      top - position.y,
      position.x + Math.max(1, position.width),
      top - position.y + Math.max(4, position.height),
    ]);
    container.querySelectorAll(".synctex-mark").forEach((mark) => mark.remove());
    clearTimeout(syncTimer);
    const mark = window.document.createElement("div");
    mark.className = "synctex-mark";
    mark.setAttribute("aria-hidden", "true");
    Object.assign(mark.style, {
      left: `${(100 * Math.min(box[0], box[2])) / page.viewport.width}%`,
      top: `${(100 * Math.min(box[1], box[3])) / page.viewport.height}%`,
      width: `${(100 * Math.abs(box[2] - box[0])) / page.viewport.width}%`,
      height: `${(100 * Math.abs(box[3] - box[1])) / page.viewport.height}%`,
    });
    page.element.append(mark);
    const bounds = container.getBoundingClientRect();
    const target = mark.getBoundingClientRect();
    container.scrollTop += target.top + target.height / 2 - bounds.top - container.clientHeight / 2;
    container.scrollLeft += target.left + target.width / 2 - bounds.left - container.clientWidth / 2;
    syncTimer = setTimeout(() => mark.remove(), 3500);
    return true;
  }
  const toolbar = controls["pdf-controls"];
  const pageInput = controls["pdf-page-number"];
  let currentPage = 1;
  let zoom: number = null;
  let revision = 0;
  let scrollFrame = 0;
  const pageScale = (page: PreviewPage) => (zoom === null ? width / page.baseWidth : zoom / 100);
  function updateControls() {
    if (window.document.activeElement !== pageInput) pageInput.value = String(currentPage);
    controls["pdf-page-count"].textContent = `/ ${pages.length}`;
    controls["pdf-page-prev"].disabled = currentPage <= 1;
    controls["pdf-page-next"].disabled = currentPage >= pages.length;
    const percent = pages.length ? pageScale(pages[currentPage - 1]) * 100 : 100;
    controls["pdf-zoom-value"].textContent = `${Math.round(percent)}%`;
    controls["pdf-zoom-out"].disabled = percent <= 25;
    controls["pdf-zoom-in"].disabled = percent >= 300;
    controls["pdf-fit-width"].setAttribute("aria-pressed", String(zoom === null));
  }
  function trackPage() {
    scrollFrame = 0;
    if (!pages.length || !container.clientHeight) return;
    const bounds = container.getBoundingClientRect();
    const center = bounds.top + container.clientHeight / 2;
    let distance = Infinity;
    for (const page of pages) {
      const rect = page.element.getBoundingClientRect();
      const next = Math.abs(Math.max(rect.top - center, center - rect.bottom, 0));
      if (next < distance) {
        distance = next;
        currentPage = page.number;
      }
    }
    updateControls();
  }
  container.addEventListener(
    "scroll",
    () => {
      if (!scrollFrame) scrollFrame = requestAnimationFrame(trackPage);
    },
    { passive: true },
  );
  function goToPage(number: number) {
    if (!Number.isInteger(number) || number < 1 || number > pages.length) return false;
    const page = pages[number - 1];
    currentPage = number;
    visible.add(page);
    void render();
    container.scrollTop += page.element.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientTop;
    updateControls();
    return true;
  }
  controls["pdf-page-prev"].onclick = () => goToPage(currentPage - 1);
  controls["pdf-page-next"].onclick = () => goToPage(currentPage + 1);
  pageInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const valid = /^\d+$/.test(pageInput.value.trim()) && goToPage(Number(pageInput.value));
    pageInput.setAttribute("aria-invalid", String(!valid));
    if (valid) pageInput.value = String(currentPage);
  });
  pageInput.addEventListener("blur", () => {
    pageInput.value = String(currentPage);
    pageInput.removeAttribute("aria-invalid");
  });
  function setZoom(value: number) {
    if (!pages.length) return;
    zoom = value;
    resize(true);
  }
  for (const [id, step] of [
    ["pdf-zoom-out", -25],
    ["pdf-zoom-in", 25],
  ] as const) {
    controls[id].onclick = () => setZoom(Math.max(25, Math.min(300, Math.round(pageScale(pages[currentPage - 1]) * 100) + step)));
  }
  controls["pdf-fit-width"].onclick = () => setZoom(null);
  const inversionStorageKey = "aux-pdf-colors-inverted";
  function setInverted(inverted: boolean) {
    container.classList.toggle("pdf-colors-inverted", inverted);
    controls["pdf-invert-colors"].setAttribute("aria-pressed", String(inverted));
  }
  setInverted(readStorage(inversionStorageKey) === "true");
  controls["pdf-invert-colors"].onclick = () => {
    const inverted = !container.classList.contains("pdf-colors-inverted");
    setInverted(inverted);
    try {
      localStorage.setItem(inversionStorageKey, String(inverted));
    } catch {
      // Keep the toggle usable when browser storage is unavailable.
    }
  };
  new ResizeObserver(() => {
    panel.style.setProperty("--pdf-controls-space", `${toolbar.getBoundingClientRect().height + 24}px`);
  }).observe(toolbar);
  const textCache = new Map<number, TextContent>();
  let searchGeneration = 0;
  let matches: PreviewMatch[] = [];
  let active = -1;
  let searching = false;
  let searchFailed = false;
  let searchTimer: ReturnType<typeof setTimeout>;
  let scrollMatch = false;
  let renderRequested = false;
  let extraction: Promise<unknown> = Promise.resolve();
  let searchOpen = false;
  let searchAnimation: Animation;

  function showSearch(open: boolean, immediate = false) {
    if (!immediate && searchOpen === open) return;
    const height = bar.hidden ? 0 : bar.getBoundingClientRect().height;
    const opacity = bar.hidden ? "0" : getComputedStyle(bar).opacity;
    const transform = bar.hidden ? "translateY(-6px)" : getComputedStyle(bar).transform;
    searchAnimation?.cancel();
    searchAnimation = null;
    searchOpen = open;

    bar.inert = !open;
    bar.hidden = false;
    if (immediate || window.matchMedia("(prefers-reduced-motion: reduce)").matches || typeof bar.animate !== "function") {
      bar.hidden = !open;
      return;
    }
    const animation = bar.animate(
      [
        { height: `${height}px`, opacity, transform },
        { height: `${open ? bar.scrollHeight : 0}px`, opacity: open ? 1 : 0, transform: open ? "translateY(0)" : "translateY(-6px)" },
      ],
      { duration: open ? 200 : 150, easing: "ease-out", fill: "both" },
    );
    searchAnimation = animation;
    animation.onfinish = () => {
      if (searchAnimation !== animation) return;
      bar.hidden = !open;
      searchAnimation = null;
      animation.cancel();
    };
  }

  function updateSearch() {
    count.textContent = searchFailed ? "Search unavailable" : searching ? "Searching…" : input.value.trim() ? `${active + 1} of ${matches.length}` : "";
    previous.disabled = next.disabled = !matches.length || searching;
  }
  function closeSearch(focus: boolean | HTMLElement = true, immediate = false) {
    searchGeneration++;
    clearTimeout(searchTimer);
    showSearch(false, immediate);

    input.value = "";
    matches = [];
    active = -1;
    searching = searchFailed = scrollMatch = false;
    pages.forEach((page) => page.highlights.replaceChildren());
    updateSearch();
    if (focus) (focus === true ? container : focus).focus({ preventScroll: true });
  }
  function openSearch() {
    if (!document) return;
    showSearch(true);

    input.focus({ preventScroll: true });
    input.select();
  }

  function toggleSearch() {
    if (!document) return;
    if (searchOpen) closeSearch();
    else openSearch();
  }

  showSearch(false, true);
  close.onclick = () => closeSearch();
  panel.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f" && document) {
      event.preventDefault();
      event.stopPropagation();
      openSearch();
    } else if (!bar.hidden && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSearch();
    } else if (!bar.hidden && event.key === "Enter" && bar.contains(event.target as Node) && !(event.target as Element).closest("button")) {
      event.preventDefault();
      navigate(event.shiftKey ? -1 : 1);
    }
  });
  async function textContent(pdf: PDFDocumentProxy, number: number, current: number) {
    if (textCache.has(number)) return textCache.get(number);
    const pending = extraction.then(async () => {
      if (current !== generation) return null;
      const page = await pdf.getPage(number);
      return page.getTextContent();
    });
    extraction = pending.catch(() => {});
    const content = await pending;
    if (current === generation) {
      textCache.set(number, content);
      if (textCache.size > 8) textCache.delete(textCache.keys().next().value);
    }
    return content;
  }
  function highlight(item: PreviewPage) {
    item.highlights.replaceChildren();
    if (!item.layer || !item.rendered || bar.hidden) return;
    const bounds = item.element.getBoundingClientRect();
    for (const [index, match] of matches.entries()) {
      if (match.page !== item.number) continue;
      for (const part of match.parts) {
        const node = item.layer.textDivs[part.item]?.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) continue;
        const range = window.document.createRange();
        range.setStart(node, part.start);
        range.setEnd(node, part.end);
        for (const rect of range.getClientRects()) {
          const mark = window.document.createElement("div");
          mark.className = `pdf-match${index === active ? " active" : ""}`;
          Object.assign(mark.style, {
            left: `${rect.left - bounds.left}px`,
            top: `${rect.top - bounds.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          });
          item.highlights.append(mark);
        }
      }
    }
    if (scrollMatch && matches[active]?.page === item.number) {
      scrollMatch = false;
      const mark = item.highlights.querySelector(".active");
      if (mark) container.scrollTop += mark.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientHeight / 2;
    }
  }
  function navigate(direction: number) {
    if (!matches.length || searching) return;
    active = (active + direction + matches.length) % matches.length;
    scrollMatch = true;
    const item = pages[matches[active].page - 1];
    container.scrollTop = item.element.offsetTop - container.offsetTop;
    visible.add(item);
    pages.forEach(highlight);
    void render();
    updateSearch();
  }
  async function search(currentSearch: number) {
    const current = generation;
    const pdf = document;
    const query = input.value.trim().replace(/\s+/gu, " ").toLowerCase();
    if (!query || !pdf) return;
    searching = true;
    updateSearch();
    const found: PreviewMatch[] = [];
    try {
      for (const item of pages) {
        if (currentSearch !== searchGeneration || current !== generation) return;
        const content = await textContent(pdf, item.number, current);
        if (currentSearch !== searchGeneration || current !== generation) return;
        let text = "";
        const positions: MatchPart[] = [];
        let itemIndex = 0;
        let lineBreak = false;
        for (const part of content.items) {
          if (!("str" in part) || typeof part.str !== "string") continue;
          if (lineBreak && text && !text.endsWith(" ")) {
            text += " ";
            positions.push(null);
          }
          for (let offset = 0; offset < part.str.length;) {
            const char = String.fromCodePoint(part.str.codePointAt(offset));
            const folded = /\s/u.test(char) ? " " : char.toLowerCase();
            if (folded !== " " || !text.endsWith(" ")) {
              text += folded;
              for (let n = 0; n < folded.length; n++) positions.push({ item: itemIndex, start: offset, end: offset + char.length });
            }
            offset += char.length;
          }
          lineBreak = part.hasEOL;
          itemIndex++;
        }
        let offset = 0;
        while ((offset = text.indexOf(query, offset)) !== -1) {
          const parts: MatchPart[] = [];
          for (const position of positions.slice(offset, offset + query.length)) {
            if (!position) continue;
            const last = parts.at(-1);
            if (last?.item === position.item) last.end = position.end;
            else parts.push({ ...position });
          }
          found.push({ page: item.number, parts });
          offset += query.length;
        }
      }
      matches = found;
      active = -1;
      searching = false;
      if (matches.length) navigate(1);
      else pages.forEach(highlight);
    } catch (error) {
      if (currentSearch !== searchGeneration || current !== generation) return;
      console.warn("PDF search failed", error);
      searching = false;
      searchFailed = true;
    }
    updateSearch();
  }
  input.addEventListener("input", () => {
    const current = ++searchGeneration;
    clearTimeout(searchTimer);
    matches = [];
    active = -1;
    searchFailed = false;
    searching = !!input.value.trim();
    pages.forEach(highlight);
    updateSearch();
    searchTimer = setTimeout((): void => void search(current), 150);
  });
  previous.onclick = () => navigate(-1);
  next.onclick = () => navigate(1);

  const release = (page: PreviewPage) => {
    page.layer?.cancel();
    page.layer = null;
    page.text.replaceChildren();
    page.highlights.replaceChildren();
    page.canvas.width = page.canvas.height = 0;
    page.rendered = false;
  };
  async function destroy(loadingTask: PDFDocumentLoadingTask) {
    try {
      await loadingTask?.destroy();
    } catch (error) {
      console.warn("PDF cleanup failed", error);
    }
  }
  async function reset() {
    loadGeneration++;
    const pending = cancelPending;
    cancelPending = null;
    await Promise.all([pending?.(), clearDisplayed()]);
  }
  function clearDisplayed() {
    setSyncEnabled(false);
    clearTimeout(syncTimer);
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    generation++;
    revision++;
    toolbar.hidden = true;
    zoom = null;
    currentPage = 1;
    pageInput.value = "1";
    pageInput.removeAttribute("aria-invalid");

    closeSearch(false, true);

    textCache.clear();
    clearTimeout(timer);
    observer?.disconnect();
    renderTask?.cancel();
    const previous = task;
    task = document = null;
    pages.forEach(release);
    pages = [];
    visible.clear();
    width = 0;
    container.replaceChildren();
    container.hidden = true;
    empty.hidden = false;
    empty.textContent = "Your PDF preview will appear here.";
    return destroy(previous);
  }
  async function render() {
    if (running) {
      renderRequested = true;
      return;
    }
    if (!document || !width || !container.getBoundingClientRect().height) return;
    renderRequested = false;
    running = true;
    const current = generation;
    const layout = revision;
    let cancelled = false;
    try {
      for (const item of pages) {
        if (current !== generation || layout !== revision) break;
        if (!visible.has(item) || item.rendered) continue;
        const page = await document.getPage(item.number);
        if (current !== generation || layout !== revision) break;
        const scale = pageScale(item);
        // Bound both device density and canvas area for unusually large pages.
        const viewport = page.getViewport({ scale });
        const density = Math.min(devicePixelRatio || 1, 2, Math.sqrt(16000000 / (viewport.width * viewport.height)));
        const pixels = page.getViewport({ scale: scale * density });
        item.canvas.width = Math.ceil(pixels.width);
        item.canvas.height = Math.ceil(pixels.height);
        renderTask = page.render({ canvas: item.canvas, canvasContext: item.canvas.getContext("2d"), viewport: pixels });
        await renderTask.promise;
        renderTask = null;
        if (current !== generation || layout !== revision || !visible.has(item)) continue;
        try {
          const content = await textContent(document, item.number, current);
          if (current !== generation || layout !== revision || !visible.has(item)) continue;
          item.element.style.setProperty("--total-scale-factor", String(scale));
          const layer = new TextLayer({ textContentSource: content, container: item.text, viewport });
          item.layer = layer;
          await layer.render();
          if (current !== generation || layout !== revision || item.layer !== layer) continue;
        } catch (error) {
          if (current !== generation || layout !== revision || error.name === "AbortException") continue;
          console.warn("PDF text layer failed", error);
        }
        if (current === generation && layout === revision) {
          item.rendered = true;
          highlight(item);
        }
        page.cleanup();
      }
    } catch (error) {
      cancelled = error.name === "RenderingCancelledException";
      if (current === generation && !cancelled) report(`PDF preview failed: ${error.message}`, "error");
    } finally {
      running = false;
      if (current !== generation || cancelled || renderRequested) void render();
    }
  }
  function resize(force = false) {
    const next = container.clientWidth;
    if (!document || next <= 0 || !container.getBoundingClientRect().height) return;
    if (next !== width || force) {
      const anchor = pages[currentPage - 1];
      const top = container.getBoundingClientRect().top + container.clientTop;
      const ratio = anchor ? (top - anchor.element.getBoundingClientRect().top) / anchor.element.getBoundingClientRect().height : 0;
      width = next;
      revision++;
      renderTask?.cancel();
      for (const page of pages) {
        const pageWidth = page.baseWidth * pageScale(page);
        page.element.style.width = `${pageWidth}px`;
        page.element.style.height = `${pageWidth * page.ratio}px`;
        release(page);
      }
      if (anchor && Number.isFinite(ratio)) {
        container.scrollTop += anchor.element.getBoundingClientRect().top - top + ratio * anchor.element.getBoundingClientRect().height;
      }
    }
    updateControls();
    void render();
  }
  new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(resize, 100);
  }).observe(container);
  return {
    openSearch,
    toggleSearch,
    setSyncEnabled,
    goToPosition,
    reset,
    async show(blob: Blob, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const current = ++loadGeneration;
      void cancelPending?.();
      let loadingTask: PDFDocumentLoadingTask;
      let cleanup: Promise<void>;
      let committed = false;
      const discard = () => (cleanup ??= destroy(loadingTask));
      const abort = () => {
        void discard();
      };
      const stale = () => {
        signal?.throwIfAborted();
        return current !== loadGeneration;
      };
      cancelPending = discard;
      signal?.addEventListener("abort", abort, { once: true });
      if (!document) empty.textContent = "Loading PDF preview…";
      report("Loading PDF preview…", "busy");
      try {
        const data = new Uint8Array(await blob.arrayBuffer());
        if (stale()) return;
        loadingTask = getDocument({
          data,
          cMapUrl: "/assets/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/assets/pdfjs/standard_fonts/",
          wasmUrl: "/assets/pdfjs/wasm/",
          isEvalSupported: false,
        });
        const pdf = await loadingTask.promise;
        if (stale()) return;
        // Prepare every page off-DOM so a failed load leaves the displayed PDF intact.
        const prepared: PreviewPage[] = [];
        const nextObserver = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const item = pages[Number((entry.target as HTMLElement).dataset.page) - 1];
              if (!item) continue;
              if (entry.isIntersecting) visible.add(item);
              else {
                visible.delete(item);
                if (item.rendered || item.layer) release(item);
              }
            }
            void render();
          },
          { root: container, rootMargin: "600px 0px" },
        );
        for (let number = 1; number <= pdf.numPages; number++) {
          const page = await pdf.getPage(number);
          if (stale()) return;
          const viewport = page.getViewport({ scale: 1 });
          const element = window.document.createElement("div");
          element.className = "pdf-page";
          element.dataset.page = String(number);
          const canvas = window.document.createElement("canvas");
          canvas.setAttribute("role", "img");
          canvas.setAttribute("aria-label", `PDF page ${number} of ${pdf.numPages}`);
          const text = window.document.createElement("div");
          text.className = "textLayer";
          const highlights = window.document.createElement("div");
          highlights.className = "pdf-highlights";
          highlights.setAttribute("aria-hidden", "true");
          element.append(canvas, text, highlights);
          prepared.push({
            number,
            element,
            canvas,
            text,
            highlights,
            viewport,
            layer: null,
            baseWidth: viewport.width,
            ratio: viewport.height / viewport.width,
            rendered: false,
          });
          page.cleanup();
        }
        if (stale()) return;

        // No await between clearing the old preview and installing its replacement.
        void clearDisplayed();
        task = loadingTask;
        document = pdf;
        pages = prepared;
        observer = nextObserver;
        committed = true;
        container.replaceChildren(...pages.map((page) => page.element));
        container.hidden = false;
        empty.hidden = true;
        toolbar.hidden = false;

        container.scrollTop = 0;
        resize();
        pages.forEach((page) => observer.observe(page.element));
        report(`PDF preview ready (${pdf.numPages} pages).`, "ready");
      } catch (error) {
        if (stale()) return;
        if (!document) empty.textContent = `PDF preview failed: ${error.message}`;
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
        if (current === loadGeneration) cancelPending = null;
        if (!committed) await discard();
      }
    },
  };
}
