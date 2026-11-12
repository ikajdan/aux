// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SnapshotLimits } from "../server-config.js";

export function validateSnapshotSizes(sizes: Iterable<number>, limits: Pick<SnapshotLimits, "snapshotBytes" | "snapshotFiles">) {
  let count = 0;
  let bytes = 0;
  for (const size of sizes) {
    count++;
    bytes += size;
    if (count > limits.snapshotFiles) throw new Error(`Project exceeds the ${limits.snapshotFiles}-file limit.`);
    if (bytes > limits.snapshotBytes) throw new Error(`Project exceeds the ${limits.snapshotBytes}-byte size limit.`);
  }
}

export function validateRequestSize(body: string, limits: Pick<SnapshotLimits, "requestBytes">) {
  if (new TextEncoder().encode(body).byteLength > limits.requestBytes) {
    throw new Error(`Build request exceeds the ${limits.requestBytes}-byte upload limit.`);
  }
}
