// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomId } from "../random-id.js";

export function createBuildOperation(fetcher: typeof fetch = fetch, id: string = randomId()) {
  const controller = new AbortController();
  const { signal } = controller;
  let submitted = false;
  let cancellation: Promise<void> | undefined;

  return {
    id,
    signal,
    async request(body: string): Promise<Response> {
      signal.throwIfAborted();
      submitted = true;
      const response = await fetcher("/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(135000)]),
      });
      signal.throwIfAborted();
      return response;
    },
    cancel(): Promise<void> {
      if (cancellation) return cancellation;
      // Cache before aborting: abort listeners may themselves call cancel().
      cancellation = Promise.resolve().then(async () => {
        if (!submitted) return;
        const response = await fetcher("/compile/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ buildId: id }),
          signal: AbortSignal.timeout(10000),
          keepalive: true,
        });
        if (!response.ok) {
          throw new Error(`Build cancellation failed: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
        }
      });
      controller.abort(new DOMException("Build canceled", "AbortError"));
      return cancellation;
    },
  };
}
