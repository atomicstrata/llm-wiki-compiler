/**
 * CLI handler for `llmwiki view` — the local read-only web viewer.
 *
 * Responsibilities:
 *   - parse and validate the host/port/allow-lan symmetry (spec
 *     §Non-Negotiable Security Requirements: non-loopback bind requires
 *     BOTH `--allow-lan` AND `--host <host>`; either alone exits 1)
 *   - build the frozen `ViewerSnapshot` once at startup
 *   - start the HTTP server and emit a parseable readiness line so
 *     test fixtures (and the user) know what URL to point a browser at
 *   - register SIGINT / SIGTERM handlers for graceful shutdown
 */

import { spawn } from "child_process";
import { startViewerServer } from "../viewer/server.js";
import { buildViewerSnapshot } from "../viewer/snapshot.js";

const LOOPBACK_HOST = "127.0.0.1";

/**
 * Bind hosts that listen on every interface. We reject these in v1
 * because the Host / Origin / Sec-Fetch-Site checks in the server are
 * built around a single canonical bind address; a wildcard bind would
 * mean any reachable interface's IP serves as a valid Host, which
 * defeats the DNS-rebind protection. A future PR can add a real
 * allowed-host model; for now, fail closed with a clear CLI error.
 */
const WILDCARD_HOSTS = new Set([
  "0.0.0.0",
  "::",
  "0:0:0:0:0:0:0:0",
  "0000:0000:0000:0000:0000:0000:0000:0000",
  "*",
]);

/** Parsed CLI options. */
interface ViewCommandOptions {
  port?: string | number;
  host?: string;
  allowLan?: boolean;
  open?: boolean;
}

/**
 * Run `llmwiki view`. Resolves once the server has bound; the returned
 * promise stays unresolved for the lifetime of the listening process so
 * Commander's exit semantics keep the event loop alive until the signal
 * handler closes the server.
 */
export default async function viewCommand(options: ViewCommandOptions): Promise<void> {
  const { host, port } = resolveBindConfig(options);
  const root = process.cwd();
  const snapshot = await buildViewerSnapshot(root);
  const handle = await startViewerServer(snapshot, { host, port });
  const url = buildReadyUrl(handle.host, handle.port);
  process.stdout.write(`Viewer ready at ${url}\n`);
  if (options.open) openInBrowser(url);
  registerShutdown(handle.close);
}

/**
 * Fire-and-forget native-shell open of the viewer URL. Failures here are
 * intentionally swallowed: a broken browser launch must not prevent the
 * server from keeping the readiness it just announced.
 */
function openInBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}

/**
 * Apply the spec's host/port symmetry: `--allow-lan` and `--host`
 * together unlock non-loopback bind; either alone is a fatal error.
 */
function resolveBindConfig(options: ViewCommandOptions): { host: string; port: number } {
  const hostFlag = typeof options.host === "string" && options.host.length > 0;
  const allowLan = options.allowLan === true;
  assertHostAllowLanSymmetry(hostFlag, allowLan);
  const host = hostFlag ? (options.host as string) : LOOPBACK_HOST;
  assertHostNotWildcard(host);
  return { host, port: parsePort(options.port) };
}

/** Reject `--host` and `--allow-lan` being supplied independently. */
function assertHostAllowLanSymmetry(hostFlag: boolean, allowLan: boolean): void {
  if (hostFlag === allowLan) return;
  throw new Error(
    "Privacy gate: --host and --allow-lan must be supplied together. " +
      "Use both to bind beyond loopback, or neither to keep the viewer on 127.0.0.1.",
  );
}

/** Reject wildcard binds that would defeat DNS-rebind protection. */
function assertHostNotWildcard(host: string): void {
  if (!WILDCARD_HOSTS.has(host)) return;
  throw new Error(
    `--host ${host} is not supported: wildcard binds defeat the viewer's DNS-rebind protection. ` +
      "Use a specific interface IP (e.g. 192.168.1.10) instead.",
  );
}

/**
 * Build the readiness-line URL. IPv6 literal hosts must be bracketed
 * (`http://[::1]:PORT/`) per RFC 3986 — bare `http://::1:PORT/` is a
 * malformed URL and won't open in a browser. Heuristic for "literal
 * IPv6": a colon in the host portion (domain names + IPv4 dotted
 * quads never contain `:`).
 */
function buildReadyUrl(host: string, port: number): string {
  if (host.includes(":")) return `http://[${host}]:${port}`;
  return `http://${host}:${port}`;
}

/** Coerce the optional --port string into a non-negative integer. */
function parsePort(raw: string | number | undefined): number {
  if (raw === undefined) return 0;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!isValidPort(value)) {
    throw new Error(`Invalid --port value: ${raw}`);
  }
  return value;
}

/** True when `value` is an integer in the legal TCP port range [0, 65535]. */
function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 65535;
}

/** Install SIGINT/SIGTERM handlers that close the server gracefully. */
function registerShutdown(close: () => Promise<void>): void {
  const shutdown = async (): Promise<void> => {
    try {
      await close();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
