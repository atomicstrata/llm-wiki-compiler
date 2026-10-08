/**
 * Port resolution and LLMWIKI_VIEW_PORT environment variable tests for `llmwiki view`.
 *
 * Verifies:
 *   - Precedence: CLI flag (`--port`) > env var (`LLMWIKI_VIEW_PORT`) > default (0).
 *   - Validation: legal port range [0, 65535], integer check, and rejection of invalid values.
 *   - Subprocess integration: invalid env var fails CLI fast with descriptive error,
 *     and CLI flag takes precedence over env var in a spawned viewer process.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import net from "net";
import path from "path";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { resolveBindConfig } from "../src/commands/view.js";
import { parsePort, resolvePort } from "../src/cli/view-port.js";
import { ENV_VIEW_PORT } from "../src/utils/constants.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import {
  startViewerCLI,
  type ViewerProcessHandle,
} from "./fixtures/run-cli-server.js";

const exec = promisify(execCb);
const CLI = path.resolve("dist/cli.js");
const CLI_TIMEOUT_MS = 30_000;

/** Allocate an unused TCP port on loopback and immediately close it. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close(() => reject(new Error("Failed to get free port address")));
        return;
      }
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Register an afterEach hook that restores the target environment variable. */
function preserveEnvVar(varName: string): void {
  const originalValue = process.env[varName];
  afterEach(() => {
    if (originalValue !== undefined) {
      process.env[varName] = originalValue;
    } else {
      delete process.env[varName];
    }
  });
}

describe("parsePort unit tests", () => {
  it("returns 0 for undefined", () => {
    expect(parsePort(undefined)).toBe(0);
  });

  it("parses valid integer ports", () => {
    expect(parsePort(0)).toBe(0);
    expect(parsePort("0")).toBe(0);
    expect(parsePort(8080)).toBe(8080);
    expect(parsePort("8080")).toBe(8080);
    expect(parsePort("  54321  ")).toBe(54321);
    expect(parsePort(65535)).toBe(65535);
    expect(parsePort("65535")).toBe(65535);
  });

  it("rejects non-numeric strings with the given label", () => {
    expect(() => parsePort("abc", "--port")).toThrowError("Invalid --port value: abc");
    expect(() => parsePort("not-a-port", ENV_VIEW_PORT)).toThrowError(
      `Invalid ${ENV_VIEW_PORT} value: not-a-port`,
    );
  });

  it("rejects floats and non-integers", () => {
    expect(() => parsePort("80.5", "--port")).toThrowError("Invalid --port value: 80.5");
    expect(() => parsePort(80.5, "--port")).toThrowError("Invalid --port value: 80.5");
  });

  it("rejects negative numbers and out-of-range values", () => {
    expect(() => parsePort("-1", "--port")).toThrowError("Invalid --port value: -1");
    expect(() => parsePort(-1, "--port")).toThrowError("Invalid --port value: -1");
    expect(() => parsePort("65536", "--port")).toThrowError("Invalid --port value: 65536");
    expect(() => parsePort(70000, ENV_VIEW_PORT)).toThrowError(
      `Invalid ${ENV_VIEW_PORT} value: 70000`,
    );
  });

  it("rejects empty or whitespace-only strings", () => {
    expect(() => parsePort("", "--port")).toThrowError("Invalid --port value: ");
    expect(() => parsePort("   ", "--port")).toThrowError("Invalid --port value:    ");
  });
});

describe("resolvePort precedence and defaults", () => {
  preserveEnvVar(ENV_VIEW_PORT);

  it("defaults to 0 when flag is undefined and env var is unset", () => {
    delete process.env[ENV_VIEW_PORT];
    expect(resolvePort(undefined)).toBe(0);
  });

  it("defaults to 0 when flag is undefined and env var is empty or whitespace", () => {
    process.env[ENV_VIEW_PORT] = "";
    expect(resolvePort(undefined)).toBe(0);

    process.env[ENV_VIEW_PORT] = "   ";
    expect(resolvePort(undefined)).toBe(0);
  });

  it("honors LLMWIKI_VIEW_PORT when flag is undefined", () => {
    process.env[ENV_VIEW_PORT] = "54321";
    expect(resolvePort(undefined)).toBe(54321);

    process.env[ENV_VIEW_PORT] = "0";
    expect(resolvePort(undefined)).toBe(0);
  });

  it("gives explicit flag precedence over LLMWIKI_VIEW_PORT", () => {
    process.env[ENV_VIEW_PORT] = "54321";
    expect(resolvePort(8080)).toBe(8080);
    expect(resolvePort("8080")).toBe(8080);
    expect(resolvePort(0)).toBe(0);
  });

  it("throws clear error when LLMWIKI_VIEW_PORT has invalid value", () => {
    process.env[ENV_VIEW_PORT] = "invalid";
    expect(() => resolvePort(undefined)).toThrowError(
      `Invalid ${ENV_VIEW_PORT} value: invalid`,
    );

    process.env[ENV_VIEW_PORT] = "99999";
    expect(() => resolvePort(undefined)).toThrowError(
      `Invalid ${ENV_VIEW_PORT} value: 99999`,
    );
  });

  it("throws clear error when flag has invalid value even if env var is set", () => {
    process.env[ENV_VIEW_PORT] = "54321";
    expect(() => resolvePort("bad-flag")).toThrowError("Invalid --port value: bad-flag");
  });
});

describe("resolveBindConfig unit behavior", () => {
  it("resolves default loopback host and port 0", () => {
    const config = resolveBindConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(0);
  });

  it("resolves explicit port", () => {
    const config = resolveBindConfig({ port: 4000 });
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4000);
  });
});

describe("CLI integration — LLMWIKI_VIEW_PORT and --port precedence", () => {
  let activeHandles: ViewerProcessHandle[] = [];

  afterEach(async () => {
    while (activeHandles.length > 0) {
      const handle = activeHandles.pop();
      if (handle) await handle.kill();
    }
  });

  it("rejects invalid LLMWIKI_VIEW_PORT on startup with exit code non-zero", async () => {
    const root = await makeTempRoot("viewer-port-invalid-env");
    let failure: { code?: number | null; stderr?: string } | null = null;
    try {
      await exec(`node "${CLI}" view`, {
        cwd: root,
        timeout: CLI_TIMEOUT_MS,
        env: { ...process.env, [ENV_VIEW_PORT]: "not-a-port" },
      });
    } catch (err) {
      failure = err as { code?: number | null; stderr?: string };
    }
    expect(failure).not.toBeNull();
    expect(failure?.code).not.toBe(0);
    expect(String(failure?.stderr ?? "")).toMatch(/Invalid LLMWIKI_VIEW_PORT value: not-a-port/);
  });

  it("binds to port specified by LLMWIKI_VIEW_PORT when --port is omitted", async () => {
    const root = await makeTempRoot("viewer-port-env-bind");
    const targetPort = await getFreePort();
    const handle = await startViewerCLI([], root, CLI_TIMEOUT_MS, {
      [ENV_VIEW_PORT]: String(targetPort),
    });
    activeHandles.push(handle);
    expect(handle.port).toBe(targetPort);
    expect(handle.stdout).toMatch(new RegExp(`Viewer ready at http://127\\.0\\.0\\.1:${targetPort}`));
  });

  it("CLI --port overrides LLMWIKI_VIEW_PORT in running server", async () => {
    const root = await makeTempRoot("viewer-port-flag-override");
    const flagPort = await getFreePort();
    let envPort = await getFreePort();
    while (envPort === flagPort) {
      envPort = await getFreePort();
    }
    expect(flagPort).not.toBe(envPort);
    const handle = await startViewerCLI(["--port", String(flagPort)], root, CLI_TIMEOUT_MS, {
      [ENV_VIEW_PORT]: String(envPort),
    });
    activeHandles.push(handle);
    expect(handle.port).toBe(flagPort);
    expect(handle.stdout).toMatch(new RegExp(`Viewer ready at http://127\\.0\\.0\\.1:${flagPort}`));
  });

  it("starts normally when --port is given alongside an invalid LLMWIKI_VIEW_PORT", async () => {
    const root = await makeTempRoot("viewer-port-flag-with-invalid-env");
    const flagPort = await getFreePort();
    const handle = await startViewerCLI(["--port", String(flagPort)], root, CLI_TIMEOUT_MS, {
      [ENV_VIEW_PORT]: "not-a-port",
    });
    activeHandles.push(handle);
    expect(handle.port).toBe(flagPort);
    expect(handle.stdout).toMatch(new RegExp(`Viewer ready at http://127\\.0\\.0\\.1:${flagPort}`));
  });
});
