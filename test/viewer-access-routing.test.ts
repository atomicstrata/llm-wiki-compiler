/**
 * Resource route dispatch and the common transport security boundary.
 * Handler doubles isolate bind-policy propagation from resource validation;
 * real resource readers have separate content and confinement controls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "http";
import http from "http";
import { startViewerServer } from "../src/viewer/server.js";
import type { ViewerSnapshot } from "../src/viewer/types.js";

/** Echo only the transport capability assigned by the server. */
function reply(res: ServerResponse, isLoopback: boolean): void {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ isLoopback }));
}

vi.mock("../src/viewer/api-artifacts.js", () => ({
  handleApiArtifact: (res: ServerResponse, _snapshot: unknown, _url: URL, local: boolean) => reply(res, local),
}));
vi.mock("../src/viewer/api-sources.js", () => ({
  handleApiSource: (res: ServerResponse, _snapshot: unknown, _path: string, local: boolean) => reply(res, local),
}));

const handles: Awaited<ReturnType<typeof startViewerServer>>[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map((handle) => handle.close())); });

/** Open a real listener; mocked resource handlers do not inspect the snapshot. */
async function start(host = "127.0.0.1") {
  const handle = await startViewerServer({} as ViewerSnapshot, { host, port: 0 });
  handles.push(handle);
  return handle;
}

const ROUTES = ["/api/artifact?ref=x", "/api/artifact/content?ref=x", "/api/source/x", "/api/source/x/content"];

/** Node's raw client permits the bind Host header that fetch discards. */
function fetchLan(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/artifact/content", headers: { Host: `0.0.0.0:${port}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
  });
}

describe("resource transport boundary", () => {
  it.each(ROUTES)("dispatches %s with loopback capability and security headers", async (route) => {
    const handle = await start();
    const response = await fetch(`http://127.0.0.1:${handle.port}${route}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ isLoopback: true });
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(response.headers.get("Content-Security-Policy")).toContain("object-src 'none'");
  });

  it.each(ROUTES)("rejects cross-origin access before dispatching %s", async (route) => {
    const handle = await start();
    const response = await fetch(`http://127.0.0.1:${handle.port}${route}`, { headers: { Origin: "https://outside.example" } });
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty("isLoopback");
  });

  it("does not grant a LAN bind byte access even to a locally connected client", async () => {
    const handle = await start("0.0.0.0");
    const response = await fetchLan(handle.port);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ isLoopback: false });
  });

  it("keeps mutating methods outside the registered surface", async () => {
    const handle = await start();
    const response = await fetch(`http://127.0.0.1:${handle.port}/api/artifact`, { method: "POST" });
    expect(response.status).toBe(404);
  });
});
