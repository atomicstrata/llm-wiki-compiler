/**
 * Host-handling regression tests for `llmwiki view`.
 *
 * Covers the PR review findings around bind addresses:
 *   - `--host ::1` actually works: server starts, accepts the bracketed
 *     `Host: [::1]:PORT` header browsers send, and treats `localhost`
 *     as an alias when the OS resolves it to `::1`.
 *   - Same-origin Origin parsing handles bracketed IPv6 hostnames.
 *   - Wildcard binds (`0.0.0.0`, `::`, `0:0:0:0:0:0:0:0`, `*`) are
 *     rejected at the CLI with a clear error rather than starting an
 *     insecure surface.
 *
 * The IPv6 cases skip gracefully when the host kernel doesn't have a
 * `::1` route — CI on some Linux configs.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "http";
import net from "net";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import {
  startViewerCLI,
  useViewerProcessLifecycle,
} from "./fixtures/run-cli-server.js";

const exec = promisify(execCb);
const CLI = path.resolve("dist/cli.js");

let ipv6Available = false;

beforeAll(async () => {
  ipv6Available = await canBindIPv6Loopback();
});

afterAll(() => {
  // nothing else owned; lifecycle hook below tears down spawned viewers.
});

async function canBindIPv6Loopback(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(0, "::1", () => {
      server.close(() => resolve(true));
    });
  });
}

function rawHttpRequestStatus(
  family: 4 | 6,
  address: string,
  port: number,
  pathname: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: address,
        port,
        method: "GET",
        path: pathname,
        family,
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

const { start: startViewer } = useViewerProcessLifecycle();

describe("CLI — wildcard host rejection", () => {
  it.each(["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "*"])("rejects --host %s with a clear error", async (host) => {
    const root = await makeTempRoot(`viewer-host-wildcard-${host.replace(/[:.*]/g, "-")}`);
    let stderr = "";
    try {
      await exec(`node "${CLI}" view --port 0 --allow-lan --host "${host}"`, { cwd: root, timeout: 5000 });
      throw new Error("expected CLI to exit non-zero for wildcard host");
    } catch (err) {
      stderr = String((err as { stderr?: string }).stderr ?? "");
    }
    expect(stderr).toMatch(/wildcard binds defeat the viewer's DNS-rebind protection/i);
  });
});

describe("server — IPv6 ::1 bind", () => {
  /**
   * Start a viewer bound to `::1`, then issue one IPv6 GET against
   * `/api/pages` using the supplied Host/Origin headers. Returns the
   * HTTP status so each test asserts the spec-defined response.
   */
  async function probeIpv6(label: string, headersBuilder: (port: number) => Record<string, string>): Promise<number> {
    const root = await makeTempRoot(`viewer-host-ipv6-${label}`);
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha" }, "Body.");
    const handle = await startViewer(root, ["--allow-lan", "--host", "::1", "--port", "0"]);
    return rawHttpRequestStatus(6, "::1", handle.port, "/api/pages", headersBuilder(handle.port));
  }

  it("accepts Host header `[::1]:PORT` when bound to ::1", async () => {
    if (!ipv6Available) return;
    const status = await probeIpv6("brackets", (port) => ({ Host: `[::1]:${port}` }));
    expect(status).toBe(200);
  });

  it("accepts the `localhost` Host alias when bound to ::1", async () => {
    if (!ipv6Available) return;
    const status = await probeIpv6("localhost", (port) => ({ Host: `localhost:${port}` }));
    expect(status).toBe(200);
  });

  it("rejects a mismatched Host header even when bound to ::1", async () => {
    if (!ipv6Available) return;
    const status = await probeIpv6("rebind", () => ({ Host: "evil.example.com" }));
    expect(status).toBe(403);
  });

  it("accepts a same-origin Origin header with bracketed IPv6", async () => {
    if (!ipv6Available) return;
    const status = await probeIpv6("origin", (port) => ({
      Host: `[::1]:${port}`,
      Origin: `http://[::1]:${port}`,
    }));
    expect(status).toBe(200);
  });
});
