// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { StatusRow, ReadCommitResult } from "isomorphic-git";
import { icon, type IconName } from "../ui-icons.js";
export interface HistoryMetadata {
  branch: string;
  base?: string;
  publication?: { localHead: string; branch: string; remoteCommit: string };
}

export function renderHistory(container: HTMLElement, meta: HistoryMetadata, changes: StatusRow[], logs: ReadCommitResult[]) {
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const sectionHeading = (label: string, count: number, iconName: IconName) => {
    const heading = element("h4", "history-title");
    heading.append(icon(iconName), element("span", "history-heading-label", label), element("span", "history-count", String(count)));
    return heading;
  };
  const changed = element("section", "history-section");
  changed.append(sectionHeading("Changes", changes.length, "files"));
  if (changes.length) {
    const list = element("ul", "history-list");
    for (const [path, head, workdir] of changes) {
      const status = workdir === 0 ? "Deleted" : head === 0 ? "Added" : "Modified";
      const row = element("li", "history-change");
      row.append(element("span", "history-path", path), element("span", `history-badge history-${status.toLowerCase()}`, status));
      list.append(row);
    }
    changed.append(list);
  }
  const recent = element("section", "history-section");

  const list = element("ol", "history-list");
  let unpublished = true;
  let publishedElsewhere = false;
  for (const entry of logs) {
    if (entry.oid === meta.publication?.localHead) {
      unpublished = false;
      publishedElsewhere = meta.publication.branch !== meta.branch;
    }
    if (entry.oid === meta.base) {
      unpublished = false;
      publishedElsewhere = false;
    }
    const { message } = entry.commit;
    const imported = /^Pull [^\r\n]+ @ [0-9a-f]{40}\s*$/i.test(message);
    if (imported) continue;
    const [subject, ...body] = message.trim().split(/\r?\n/);
    const row = element("li", "history-commit");
    const heading = element("div", "history-commit-heading");
    heading.append(element("p", "history-message", subject));
    if (unpublished) heading.append(element("span", "history-badge history-unpublished", "Unpublished"));
    else if (publishedElsewhere) heading.append(element("span", "history-badge", `Published to ${meta.publication.branch}`));
    row.append(heading);
    if (body.join("\n").trim()) row.append(element("p", "history-body", body.join("\n").trim()));

    list.append(row);
  }
  if (list.children.length) {
    recent.append(sectionHeading("Commits", list.children.length, "commit"), list);
    container.replaceChildren(changed, recent);
  } else {
    container.replaceChildren(changed);
  }
}
