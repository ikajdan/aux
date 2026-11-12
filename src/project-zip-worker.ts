// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { zipSync } from "fflate";

// Compress inside this same-origin worker; fflate's async API spawns blob workers blocked by CSP.
self.onmessage = (event: MessageEvent<Record<string, Uint8Array>>) => {
  try {
    const bytes = zipSync(event.data);
    self.postMessage({ bytes }, { transfer: [bytes.buffer] });
  } catch (error) {
    self.postMessage({ error: `Could not create project ZIP: ${error instanceof Error ? error.message : String(error)}` });
  }
};
