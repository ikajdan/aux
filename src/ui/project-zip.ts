// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export function createProjectZip(entries: Record<string, Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/project-zip-worker.js");
    const finish = (error?: Error, bytes?: Uint8Array<ArrayBuffer>) => {
      clearTimeout(timeout);
      worker.terminate();
      if (error) reject(error);
      else resolve(bytes);
    };
    const timeout = setTimeout(() => finish(new Error("Project ZIP creation timed out. Try downloading a smaller project.")), 120_000);
    worker.onmessage = (event: MessageEvent<{ bytes?: Uint8Array<ArrayBuffer>; error?: string }>) => {
      if (event.data.error) finish(new Error(event.data.error));
      else if (event.data.bytes instanceof Uint8Array) finish(undefined, event.data.bytes);
      else finish(new Error("Could not create project ZIP: invalid worker response."));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(new Error(event.message || "Could not start project ZIP worker."));
    };
    worker.onmessageerror = () => finish(new Error("Could not receive project ZIP from worker."));
    try {
      worker.postMessage(entries);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
