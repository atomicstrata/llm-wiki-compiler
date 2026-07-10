/**
 * @file test/fixtures/viewer-fetch.ts
 * @description Shared HTTP fetch helpers for viewer subprocess tests.
 *
 * Several viewer suites spin up the `llmwiki view` CLI and issue real fetches
 * against the bound loopback address. `fetchJson` / `fetchText` are identical
 * boilerplate across those files, so they live here once (the deduped form
 * fallow flags otherwise). Each takes a {@link ViewerProcessHandle} and a
 * pathname and returns the parsed response.
 */

import type { ViewerProcessHandle } from "./run-cli-server.js";

/** GET `pathname` against the viewer and return its status plus parsed body
 *  (JSON when the response is `application/json`, otherwise raw text). */
export async function fetchJson(
  handle: ViewerProcessHandle,
  pathname: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://${handle.host}:${handle.port}${pathname}`);
  const body = res.headers.get("content-type")?.includes("application/json")
    ? await res.json()
    : await res.text();
  return { status: res.status, body };
}

/** GET `pathname` against the viewer and return its status, Content-Type, and text body. */
export async function fetchText(
  handle: ViewerProcessHandle,
  pathname: string,
): Promise<{ status: number; contentType: string | null; body: string }> {
  const res = await fetch(`http://${handle.host}:${handle.port}${pathname}`);
  return {
    status: res.status,
    contentType: res.headers.get("Content-Type"),
    body: await res.text(),
  };
}
