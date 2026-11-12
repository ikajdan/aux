// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { build } from "esbuild";
import { mkdir, rm, cp, copyFile, readFile, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist");
await cp("assets", "dist/assets", { recursive: true });

await mkdir("dist/assets/pdfjs", { recursive: true });
await copyFile("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "dist/assets/pdfjs/pdf.worker.min.mjs");
for (const directory of ["cmaps", "standard_fonts", "wasm"])
  await cp(`node_modules/pdfjs-dist/${directory}`, `dist/assets/pdfjs/${directory}`, { recursive: true });
const viewerCSS = await readFile("node_modules/pdfjs-dist/web/pdf_viewer.css", "utf8");
const textStart = viewerCSS.indexOf(".textLayer{");
const textEnd = viewerCSS.indexOf(".textLayer .highlight{", textStart);
if (textStart < 0 || textEnd < 0) throw new Error("PDF.js text layer CSS not found");
const hiddenHelpers = viewerCSS.match(/#hiddenCopyElement,\s*\.hiddenCanvasElement\s*\{[^}]*\}/)?.[0];
if (!hiddenHelpers) throw new Error("PDF.js hidden helper CSS not found");
await writeFile(
  "dist/assets/pdfjs/text-layer.css",
  viewerCSS.slice(textStart, textEnd).replaceAll(".textLayer", ".pdf-page .textLayer") + "\n" + hiddenHelpers,
);
const { version } = JSON.parse(await readFile("package.json", "utf8"));
await build({
  define: { __APP_VERSION__: JSON.stringify(version) },
  entryPoints: ["src/bootstrap.ts"],
  outfile: "dist/app.js",
  bundle: true,
  platform: "browser",
  target: ["es2022"],
  legalComments: "eof",
});
await build({
  entryPoints: ["src/project-zip-worker.ts"],
  outfile: "dist/project-zip-worker.js",
  bundle: true,
  platform: "browser",
  target: ["es2022"],
  legalComments: "eof",
});
await build({
  entryPoints: ["src/application.css"],
  outfile: "dist/styles.css",
  bundle: true,
  external: ["./assets/*", "/assets/*"],
  legalComments: "eof",
});
await copyFile("src/application.html", "dist/index.html");
