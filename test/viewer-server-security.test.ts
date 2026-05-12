/**
 * Security regression tests for `llmwiki view`.
 *
 * Validates the spec's §Non-Negotiable Security Requirements on a live
 * subprocess: every registered route emits the exact CSP, CORP, nosniff,
 * and Referrer-Policy headers — including the Slice 2 placeholders for
 * `/` and `/assets/*`. Cross-site `Origin`, `Sec-Fetch-Site: cross-site`,
 * and DNS-rebind-style `Host` mismatch are rejected with HTTP 403.
 */

import { describe, it, expect } from "vitest";
import http from "http";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import path from "path";
import {
  useViewerProcessLifecycle,
  type ViewerProcessHandle,
} from "./fixtures/run-cli-server.js";

const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none'";

const { start: startViewerProcess } = useViewerProcessLifecycle();

async function startViewer(): Promise<ViewerProcessHandle> {
  const root = await makeTempRoot("viewer-security");
  await writePage(path.join(root, "wiki/concepts"), "x", { title: "X" }, "Body.");
  return startViewerProcess(root);
}

async function rawFetch(
  handle: ViewerProcessHandle,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://${handle.host}:${handle.port}${pathname}`, { headers });
}

/**
 * Low-level HTTP request that bypasses the fetch spec's forbidden-header
 * list (notably `Host`), so we can prove the server rejects mismatched
 * Host values — the DNS-rebinding attack the spec calls out.
 */
function rawHttpRequestStatus(
  handle: ViewerProcessHandle,
  pathname: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: handle.host,
        port: handle.port,
        method: "GET",
        path: pathname,
        headers,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("security headers", () => {
  it.each([
    ["/", 200],
    ["/assets/viewer.js", 200],
    ["/assets/anything.js", 404],
    ["/api/pages", 200],
    ["/api/health", 200],
    ["/api/page/concepts/x", 200],
    ["/api/search?q=x", 200],
    // Unregistered route — still carries the mandatory headers — the
    // spec requires every response to be hardened, not just registered API hits.
    ["/nope", 404],
  ])("emits CSP / CORP / nosniff / Referrer-Policy on %s", async (pathname, expectedStatus) => {
    const handle = await startViewer();
    const res = await rawFetch(handle, pathname);
    expect(res.status).toBe(expectedStatus);
    expect(res.headers.get("Content-Security-Policy")).toBe(EXPECTED_CSP);
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("origin and host validation", () => {
  it("rejects requests whose Host header does not match the bound host:port (DNS rebind)", async () => {
    const handle = await startViewer();
    const status = await rawHttpRequestStatus(handle, "/api/pages", { Host: "evil.example.com" });
    expect(status).toBe(403);
  });

  it("accepts the localhost alias for a 127.0.0.1 bind", async () => {
    const handle = await startViewer();
    const status = await rawHttpRequestStatus(handle, "/api/pages", {
      Host: `localhost:${handle.port}`,
    });
    expect(status).toBe(200);
  });

  it("rejects browser requests with a cross-site Origin header", async () => {
    const handle = await startViewer();
    const res = await rawFetch(handle, "/api/pages", { Origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
  });

  it("accepts same-origin Origin headers", async () => {
    const handle = await startViewer();
    const res = await rawFetch(handle, "/api/pages", {
      Origin: `http://${handle.host}:${handle.port}`,
    });
    expect(res.status).toBe(200);
  });

  it("rejects Sec-Fetch-Site: cross-site", async () => {
    const handle = await startViewer();
    const res = await rawFetch(handle, "/api/pages", { "Sec-Fetch-Site": "cross-site" });
    expect(res.status).toBe(403);
  });

  it("rejects bad Host on an unregistered route with 403 (origin check fires before 404)", async () => {
    const handle = await startViewer();
    const status = await rawHttpRequestStatus(handle, "/nope", { Host: "evil.example.com" });
    expect(status).toBe(403);
  });

  it("rejects cross-site Origin on an unregistered route with 403", async () => {
    const handle = await startViewer();
    const res = await rawFetch(handle, "/nope", { Origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
  });
});
