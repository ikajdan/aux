// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { build } from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// Keep the factory intact; replace only browser/transport module boundaries.
const imports = {
  "build-operation": ["createBuildOperation"],
  "snapshot-limits": ["validateSnapshotSizes", "validateRequestSize"],
  "symlink-files": ["materializeSymlinkFiles"],
  "file-operation-progress": ["createFileOperationProgress"],
  "gitlab-sync": ["encode64", "decode64"],
};
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../../../src/workspace/document-build.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  plugins: [{
    name: "build-test-boundaries",
    setup(build) {
      build.onResolve({ filter: /\/(build-operation|snapshot-limits|symlink-files|file-operation-progress|gitlab-sync)\.js$/ }, ({ path }) => ({ path: path.split("/").at(-1).replace(/\.js$/, ""), namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        contents: imports[path].map((name) => `export const ${name} = (...args) => mocks.${name}(...args);`).join("\n"),
      }));
    },
  }],
});

export function loadDocumentBuild(mocks = {}) {
  const context = vm.createContext({
    module: { exports: {} }, Blob,
    mocks: {
      validateSnapshotSizes() {},
      validateRequestSize() {},
      materializeSymlinkFiles: (files) => files,
      createFileOperationProgress: () => () => {},
      encode64: (bytes) => Buffer.from(bytes).toString("base64"),
      decode64: (text) => new Uint8Array(Buffer.from(text, "base64")),
      ...mocks,
    },
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  return context.module.exports.createDocumentBuild;
}
