/**
 * The viewer's origin policy behind a reverse proxy.
 *
 * A proxy serves the viewer at a public origin, so browsers send that origin in
 * `Host` and `Origin`. Without `publicOrigin` those requests are rejected, which
 * leaves a proxied viewer with a shell whose scripts and styles all fail. With
 * it, exactly that origin is accepted, and nothing else is loosened except
 * cross-site navigation to the data-free shell.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { useTempRoot } from "./fixtures/temp-root.js";
import { viewerRequest } from "./fixtures/lan-request.js";
import { startViewerServer } from "../src/viewer/server.js";
import { resolvePublicOrigin } from "../src/commands/view.js";
import type { ViewerSnapshot } from "../src/viewer/types.js";

const PUBLIC_ORIGIN = "https://wiki.example.com";
/** A registered route that needs no snapshot data: an absent image answers 404, never 403. */
const DATA_ROUTE = "/api/source-image/absent.md/absent.png";
const FORBIDDEN = 403;
const NAVIGATION = { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };

describe("viewer origin policy with a public origin", () => {
  const ctx = useTempRoot(["sources"]);
  let handle: Awaited<ReturnType<typeof startViewerServer>> | undefined;
  afterEach(async () => { await handle?.close(); handle = undefined; });

  async function start(publicOrigin?: string): Promise<number> {
    const snapshot = { root: ctx.dir, sourceFilenames: [] } as unknown as ViewerSnapshot;
    handle = await startViewerServer(snapshot, { host: "127.0.0.1", port: 0, publicOrigin });
    return handle.port;
  }
  const loopbackHost = (port: number): Record<string, string> => ({ Host: `127.0.0.1:${port}` });

  it("rejects a proxied browser request when no public origin is configured", async () => {
    const port = await start();
    const response = await viewerRequest(port, DATA_ROUTE, { ...loopbackHost(port), Origin: PUBLIC_ORIGIN });
    expect(response.status).toBe(FORBIDDEN);
  });

  it("accepts the public origin whether or not the proxy rewrites Host", async () => {
    const port = await start(PUBLIC_ORIGIN);
    const rewritten = await viewerRequest(port, DATA_ROUTE, { ...loopbackHost(port), Origin: PUBLIC_ORIGIN });
    const preserved = await viewerRequest(port, DATA_ROUTE, { Host: "wiki.example.com", Origin: PUBLIC_ORIGIN });
    expect([rewritten.status, preserved.status]).toEqual([404, 404]);
  });

  it.each([
    ["another site's Origin", { Origin: "https://evil.example.com" }],
    ["the public host on another scheme", { Origin: "http://wiki.example.com" }],
  ])("still rejects %s", async (_label, headers) => {
    const port = await start(PUBLIC_ORIGIN);
    expect((await viewerRequest(port, DATA_ROUTE, { ...loopbackHost(port), ...headers })).status).toBe(FORBIDDEN);
  });

  it("still rejects an unknown Host", async () => {
    const port = await start(PUBLIC_ORIGIN);
    expect((await viewerRequest(port, DATA_ROUTE, { Host: "evil.example.com" })).status).toBe(FORBIDDEN);
  });

  it("admits a cross-site navigation to the shell, but not to a data route", async () => {
    const port = await start(PUBLIC_ORIGIN);
    const shell = await viewerRequest(port, "/", { ...loopbackHost(port), ...NAVIGATION });
    const data = await viewerRequest(port, DATA_ROUTE, { ...loopbackHost(port), ...NAVIGATION });
    expect(shell.status).not.toBe(FORBIDDEN);
    expect(data.status).toBe(FORBIDDEN);
  });

  it("rejects a cross-site navigation to the shell without a public origin", async () => {
    const port = await start();
    expect((await viewerRequest(port, "/", { ...loopbackHost(port), ...NAVIGATION })).status).toBe(FORBIDDEN);
  });
});

describe("resolvePublicOrigin", () => {
  it("normalizes a bare origin and keeps an explicit port", () => {
    expect(resolvePublicOrigin("https://Wiki.Example.com")).toBe("https://wiki.example.com");
    expect(resolvePublicOrigin("http://localhost:8080")).toBe("http://localhost:8080");
    expect(resolvePublicOrigin(undefined)).toBeUndefined();
  });

  it.each([
    "wiki.example.com", "https://wiki.example.com/docs", "https://wiki.example.com?x=1",
    "https://user:secret@wiki.example.com", "ftp://wiki.example.com", "",
  ])("rejects %j", (value) => {
    expect(() => resolvePublicOrigin(value)).toThrow(/Invalid --public-origin/);
  });
});
