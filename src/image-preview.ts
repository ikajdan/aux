// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

const imageTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml" };

export function imageType(path: string) {
  const extension = path.split(".").pop().toLowerCase();
  return Object.hasOwn(imageTypes, extension) ? imageTypes[extension] : null;
}

function fileSize(size: number) {
  if (size < 1024) return `${size} ${size === 1 ? "byte" : "bytes"}`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]} (${size} bytes)`;
}

export function createImagePreview(container: HTMLElement) {
  let url: string = null;
  let image: HTMLImageElement = null;
  function reset() {
    if (image) {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
    }
    if (url) URL.revokeObjectURL(url);
    url = null;
    image = null;
    container.replaceChildren();
    container.hidden = true;
  }
  return {
    reset,
    rename(path: string) {
      if (image) image.alt = path;
    },
    show(bytes: BlobPart, path: string) {
      reset();
      container.hidden = false;
      const type = imageType(path);
      const blob = new Blob([bytes], { type: type || "" });
      const details = document.createElement("dl");
      details.className = "image-preview-details";
      details.setAttribute("aria-label", "Image details");
      details.hidden = true;
      function detail(label: string, value: string) {
        const term = document.createElement("dt");
        term.textContent = label;
        const description = document.createElement("dd");
        description.textContent = value;
        details.append(term, description);
        return description;
      }
      const dimensions = detail("Dimensions", "Unavailable");
      detail("File size", fileSize(blob.size));
      const format = detail("Format", type === "image/svg+xml" ? "SVG" : type ? type.slice(6).toUpperCase() : "Unknown");
      format.title = "Format inferred from the file extension.";
      const current = document.createElement("img");
      image = current;
      current.alt = path;
      current.hidden = true;
      const message = document.createElement("p");
      message.setAttribute("role", "status");
      message.textContent = "Loading image…";
      container.append(current, message, details);
      current.onload = () => {
        if (image !== current) return;
        current.hidden = false;
        if (current.naturalWidth > 0 && current.naturalHeight > 0) {
          dimensions.textContent = `${current.naturalWidth} × ${current.naturalHeight} px`;
        }
        details.hidden = false;
        message.remove();
      };
      current.onerror = () => {
        if (image !== current) return;
        current.hidden = true;
        dimensions.textContent = "Unavailable";
        details.hidden = false;
        message.textContent = "Unable to preview this image. The file may be invalid or unsupported. Download it to inspect the original.";
      };
      url = URL.createObjectURL(blob);
      current.src = url;
    },
  };
}
