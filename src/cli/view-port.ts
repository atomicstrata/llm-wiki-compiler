/**
 * CLI listening port resolution for `llmwiki view`.
 *
 * Scopes environment variable parsing to the CLI invocation layer so
 * programmatic view callers and downstream command pipelines (e.g. quickstart)
 * remain isolated and default to port 0 unless explicitly configured.
 */

import { ENV_VIEW_PORT } from "@atomicstrata/llmwiki-core/compiler-cli";

/** Legal TCP port range bounds. */
const MIN_PORT = 0;
const MAX_PORT = 65535;

/** True when `value` is an integer in the legal TCP port range [0, 65535]. */
function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

/** Coerce the optional port string or number into a legal TCP port [0, 65535]. */
export function parsePort(raw: string | number | undefined, label: string = "--port"): number {
  if (raw === undefined) return 0;
  const trimmed = typeof raw === "string" ? raw.trim() : raw;
  const value = typeof trimmed === "number" ? trimmed : Number(trimmed);
  const isDigits =
    typeof trimmed === "number"
      ? Number.isInteger(trimmed)
      : typeof trimmed === "string" && /^\d+$/.test(trimmed);

  if (!isDigits || !isValidPort(value)) {
    throw new Error(`Invalid ${label} value: ${raw}`);
  }
  return value;
}

/**
 * Resolve the listening port honoring precedence:
 * explicit CLI flag (`--port`) > environment variable (`LLMWIKI_VIEW_PORT`) > default (0).
 */
export function resolvePort(flagPort: string | number | undefined): number {
  if (flagPort !== undefined) {
    return parsePort(flagPort, "--port");
  }
  const envVal = process.env[ENV_VIEW_PORT];
  if (envVal !== undefined && envVal.trim().length > 0) {
    return parsePort(envVal.trim(), ENV_VIEW_PORT);
  }
  return 0;
}
