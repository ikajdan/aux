// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Find an unused sibling for an already-conflicting project-relative file path.
 * The caller must include directories and reserved batch destinations in `exists`,
 * and reserve/write the returned path before allocating the next one.
 * Existence-check failures propagate rather than risking an overwrite.
 */
export async function uniqueUploadPath(path: string, exists: (path: string) => boolean | Promise<boolean>): Promise<string> {
  const parts = path.split("/");
  if (/^[a-z]:/i.test(path) || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)
    || parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new Error("Invalid project file path for upload.");
  }
  const name = parts.pop()!;
  const directory = parts.length ? `${parts.join("/")}/` : "";
  const dot = name.lastIndexOf(".");
  // Dotfiles and trailing dots are names, not empty stems/extensions.
  const extensionStart = dot > 0 && dot < name.length - 1 ? dot : name.length;
  const stem = name.slice(0, extensionStart);
  const extension = name.slice(extensionStart);
  for (let number = 2; number < Number.MAX_SAFE_INTEGER; number++) {
    const candidate = `${directory}${stem} (${number})${extension}`;
    if (!await exists(candidate)) return candidate;
  }
  throw new Error("Cannot allocate a unique upload filename.");
}
