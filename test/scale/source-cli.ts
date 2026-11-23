/**
 * @file test/scale/source-cli.ts
 * @description The real source CLI entry (`src/cli.ts`, run by Bun directly
 * from TypeScript with the repository's tsconfig path mapping) as its own
 * process in a project directory, with no provider configured. Shared by the
 * scale CLI tests; installed-package (Node) behaviour is verified separately
 * at the gates.
 *
 * The child is `process.execPath` and must be Bun (Node cannot run the
 * TypeScript source), so anything else refuses before launch. It runs with
 * `--no-env-file` (Bun would otherwise load a `.env` from the project
 * directory) and `--no-install` (a missing package fails instead of being
 * fetched). Its environment is built from an explicit allowlist of the
 * already-sanitized test environment, never the whole parent environment, so
 * no ambient credential reaches it; the provider variables are then blanked
 * so any model route refuses. The run's preloads are kept: an inherited
 * `BUN_OPTIONS` (and `NODE_OPTIONS` for Node descendants) passes through, and
 * a configured child guard (`child-guard-bootstrap.ts`) is added for this Bun
 * child after the inherited preloads.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { CHILD_GUARD_ENV, childGuardEnv, executingRuntime, inheritedRuntimeOptions } from "../fixtures/child-guard-bootstrap.js";

const exec = promisify(execFile);
const REPO = path.resolve(".");
const NO_PROVIDER = { LLMWIKI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", LLMWIKI_CLAUDE_SETTINGS_PATH: "/path/does/not/exist.json" };
/** Bun runtime flags: no `.env` discovery, no auto-install, and the repository's tsconfig path mapping whatever the cwd. */
const SOURCE_RUNTIME_FLAGS = ["--no-env-file", "--no-install", `--tsconfig-override=${path.join(REPO, "tsconfig.json")}`];

/**
 * Parent variables the source CLI child may see (locations, locale, test profile and guard settings only).
 * Every child guard bootstrap setting comes from CHILD_GUARD_ENV itself, so a setting the bootstrap adds
 * (such as the runtime declaration) cannot be dropped here and silently narrow a further child's guard.
 */
export const SOURCE_CLI_ALLOWED_ENV: readonly string[] = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "NO_COLOR", "AWS_EC2_METADATA_DISABLED", "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  "LLMWIKI_TEST_STORAGE_PROFILE", "OFFLINE_GUARD_LOG", "OFFLINE_GUARD_DENY_EXEC", "SYNC_PHASE_PROFILE_LOG", "SYNC_START_MARKER_LOG",
  ...Object.values(CHILD_GUARD_ENV),
  "NODE_OPTIONS", "BUN_OPTIONS",
];

/**
 * The child's environment: the allowlisted parent values, the run's guard preloads, then the blanked provider.
 *
 * @returns The explicit environment of the Bun source CLI child (throws, through `childGuardEnv`, when a
 *   configured guard does not declare Bun coverage).
 */
export function sourceCliEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of SOURCE_CLI_ALLOWED_ENV) if (process.env[name] !== undefined) environment[name] = process.env[name];
  const guard = childGuardEnv("bun");
  const preloads = inheritedRuntimeOptions("bun", ...(guard.BUN_OPTIONS === undefined ? [] : [guard.BUN_OPTIONS]));
  return { ...environment, ...guard, ...(preloads === "" ? {} : { BUN_OPTIONS: preloads }), ...NO_PROVIDER };
}

/** Run the source CLI with `args` in `cwd` within `timeoutMs`; returns its exit code and output. */
export async function runSourceCli(cwd: string, args: readonly string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  if (executingRuntime() !== "bun") throw new Error("source CLI route: the TypeScript source CLI runs only under Bun; the installed Node CLI is a separate gate");
  const argv = [...SOURCE_RUNTIME_FLAGS, path.join(REPO, "src", "cli.ts"), ...args];
  try {
    const { stdout, stderr } = await exec(process.execPath, argv, { cwd, env: sourceCliEnvironment(), timeout: timeoutMs });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}
