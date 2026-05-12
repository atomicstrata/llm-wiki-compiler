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
  const url = `http://${handle.host}:${handle.port}`;
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
  if (hostFlag !== allowLan) {
    throw new Error(
      "Privacy gate: --host and --allow-lan must be supplied together. " +
        "Use both to bind beyond loopback, or neither to keep the viewer on 127.0.0.1.",
    );
  }
  const host = hostFlag ? (options.host as string) : LOOPBACK_HOST;
  const port = parsePort(options.port);
  return { host, port };
}

/** Coerce the optional --port string into a non-negative integer. */
function parsePort(raw: string | number | undefined): number {
  if (raw === undefined) return 0;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`Invalid --port value: ${raw}`);
  }
  return value;
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
