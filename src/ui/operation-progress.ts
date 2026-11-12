// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

const progressVerbs: Record<string, string> = {
  "force pull": "Force-pulling",
  new: "Creating",
  push: "Pushing",
  publish: "Publishing",
  create: "Creating",
  open: "Opening",
  save: "Saving",
  restore: "Restoring",
  discard: "Discarding",
  pull: "Pulling",
  build: "Building",
  refresh: "Refreshing",
  download: "Downloading",
  upload: "Uploading",
  rename: "Renaming",
  delete: "Deleting",
  remove: "Removing",
  copy: "Copying",
  cut: "Cutting",
  paste: "Pasting",
};

export function operationProgress(label: string): string {
  if (/^Edit(?: Document)?$/i.test(label)) return "Opening document";
  return label.replace(/^(force pull|\w+)(?=\s|$)/i, (verb) => progressVerbs[verb.toLowerCase()] || verb);
}
