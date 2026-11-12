// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/workspace/build-operation.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { createBuildOperation } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

function deferredFetch({ honorAbort = true } = {}) {
  const calls = [];
  const fetcher = (url, options) => new Promise((resolve, reject) => {
    const onAbort = () => reject(options.signal.reason);
    const cleanup = () => options.signal.removeEventListener("abort", onAbort);
    calls.push({
      url,
      options,
      respond(response = new Response()) { cleanup(); resolve(response); },
      fail(error) { cleanup(); reject(error); },
    });
    if (honorAbort) {
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) onAbort();
    }
  });
  return { calls, fetcher };
}

function isBuildAbort(error) {
  assert.ok(error instanceof DOMException);
  assert.equal(error.name, "AbortError");
  assert.equal(error.message, "Build canceled");
  return true;
}

test("request forwards the caller's JSON body and returns the response with a bounded signal", async (t) => {
  const timeouts = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    const controller = new AbortController();
    timeouts.push({ milliseconds, controller });
    return controller.signal;
  });
  const { calls, fetcher } = deferredFetch();
  const operation = createBuildOperation(fetcher, "build-request");
  const body = JSON.stringify({ buildId: operation.id, source: "document" });
  const request = operation.request(body);
  assert.equal(operation.id, "build-request");
  assert.equal(operation.signal.aborted, false);
  assert.equal(calls[0].url, "/compile");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(calls[0].options.headers, { "Content-Type": "application/json" });
  assert.equal(calls[0].options.body, body);
  assert.notEqual(calls[0].options.signal, operation.signal);
  assert.deepEqual(timeouts.map(({ milliseconds }) => milliseconds), [135000]);
  const response = new Response("compiled");
  calls[0].respond(response);
  assert.equal(await request, response);
});

test("cancel immediately aborts a pending request but uses a separate live transport, exactly once", async (t) => {
  const timeouts = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    const signal = new AbortController().signal;
    timeouts.push({ milliseconds, signal });
    return signal;
  });
  const { calls, fetcher } = deferredFetch();
  const operation = createBuildOperation(fetcher, "build-cancel");
  const request = operation.request(JSON.stringify({ buildId: operation.id }));
  const rejected = assert.rejects(request, isBuildAbort);
  let reentrantCancellation;
  operation.signal.addEventListener("abort", () => { reentrantCancellation = operation.cancel(); });
  const cancellation = operation.cancel();
  assert.equal(operation.signal.aborted, true);
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(operation.cancel(), cancellation);
  assert.equal(reentrantCancellation, cancellation);
  await rejected;
  assert.equal(calls.length, 2);
  const transport = calls[1];
  assert.equal(transport.url, "/compile/cancel");
  assert.equal(transport.options.method, "POST");
  assert.deepEqual(transport.options.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(transport.options.body), { buildId: "build-cancel" });
  assert.equal(transport.options.keepalive, true);
  assert.deepEqual(timeouts.map(({ milliseconds }) => milliseconds), [135000, 10000]);
  assert.equal(transport.options.signal, timeouts[1].signal);
  assert.notEqual(transport.options.signal, calls[0].options.signal);
  assert.equal(transport.options.signal.aborted, false);
  transport.respond();
  await cancellation;
  assert.equal(operation.cancel(), cancellation);
  assert.equal(calls.length, 2);
});

test("cancellation before submission makes no network request, including later request attempts", async () => {
  const { calls, fetcher } = deferredFetch();
  const operation = createBuildOperation(fetcher, "unsubmitted");
  const cancellation = operation.cancel();
  assert.equal(operation.signal.aborted, true);
  assert.equal(operation.cancel(), cancellation);
  await assert.rejects(operation.request("{}"), isBuildAbort);
  await cancellation;
  assert.equal(calls.length, 0);
});

test("a late successful response cannot escape cancellation even if fetch ignores abort", async () => {
  const { calls, fetcher } = deferredFetch({ honorAbort: false });
  const operation = createBuildOperation(fetcher, "late-response");
  const request = operation.request("{}");
  const rejected = assert.rejects(request, isBuildAbort);
  const cancellation = operation.cancel();
  calls[0].respond(new Response("too late"));
  await rejected;
  calls[1].respond();
  await cancellation;
});

test("failed cancellation reports HTTP status and retains the same rejected promise", async () => {
  const { calls, fetcher } = deferredFetch();
  const operation = createBuildOperation(fetcher, "failed-cancel");
  const request = operation.request("{}");
  const rejectedRequest = assert.rejects(request, isBuildAbort);
  const cancellation = operation.cancel();
  const rejectedCancellation = assert.rejects(cancellation, /Build cancellation failed: HTTP 503 Service Unavailable/);
  await rejectedRequest;
  calls[1].respond(new Response("unavailable", { status: 503, statusText: "Service Unavailable" }));
  await rejectedCancellation;
  assert.equal(operation.cancel(), cancellation);
  assert.equal(calls.length, 2);
});

test("cancellation transport errors are reported without retrying", async () => {
  const { calls, fetcher } = deferredFetch();
  const operation = createBuildOperation(fetcher, "network-failure");
  const request = operation.request("{}");
  const rejectedRequest = assert.rejects(request, isBuildAbort);
  const cancellation = operation.cancel();
  const error = new TypeError("Network unavailable");
  const rejectedCancellation = assert.rejects(cancellation, (actual) => actual === error);
  await rejectedRequest;
  calls[1].fail(error);
  await rejectedCancellation;
  assert.equal(operation.cancel(), cancellation);
  assert.equal(calls.length, 2);
});

test("the compile timeout rejects the request without aborting the local operation signal", async (t) => {
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => timeout.signal);
  const { fetcher } = deferredFetch();
  const operation = createBuildOperation(fetcher, "timeout");
  const request = operation.request("{}");
  const reason = new DOMException("Build timed out", "TimeoutError");
  const rejected = assert.rejects(request, (error) => error === reason);
  timeout.abort(reason);
  await rejected;
  assert.equal(operation.signal.aborted, false);
});
