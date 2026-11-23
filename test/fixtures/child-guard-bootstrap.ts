/**
 * Test-only offline-guard bootstrap for generated child scripts.
 *
 * A qualification run guards test processes by preloading its offline guard
 * through `NODE_OPTIONS`. Some test children cannot inherit that preload: the
 * Codex provider deliberately gives Codex only an environment allowlist, so a
 * generated fake `codex` (and any descendant the fake starts) runs without the
 * parent's `NODE_OPTIONS`. The product behaviour stays as it is. Instead, when
 * a run configures this bootstrap, each generated script installs the run's
 * guard itself, before any of its own work:
 *
 *  1. it sets the guard's own two settings from values embedded at generation time;
 *  2. it loads the guard synchronously with `require` (the guard is a synchronous
 *     ES module without top-level await, which Node's `require` accepts);
 *  3. it restores both settings exactly, so the script then observes precisely
 *     the environment the product handed it;
 *  4. it stops (throws) unless the guard registered its process-wide marker;
 *  5. optionally, it appends `{pid, ppid, role}` to a census file, which lets a
 *     run match guard records to fake and descendant processes.
 *
 * Configuration, read from the guarded parent's environment when a script is
 * generated. With none of these set, generated scripts are unchanged:
 *  - `LLMWIKI_TEST_CHILD_GUARD_URL`: `file:` URL of the guard module (enables the bootstrap);
 *  - `LLMWIKI_TEST_CHILD_GUARD_LOG`: absolute path of the guard's log;
 *  - `LLMWIKI_TEST_CHILD_GUARD_DENY_EXEC`: colon-separated absolute executables the guard refuses;
 *  - `LLMWIKI_TEST_CHILD_GUARD_CENSUS`: optional absolute path of the census file;
 *  - `LLMWIKI_TEST_CHILD_GUARD_RUNTIMES`: optional comma-separated runtimes the configured
 *    guard module covers (`node`, or `node,bun` for a runtime-aware entry that also installs
 *    and verifies the Bun-native guard under Bun); `node` when unset.
 * Setting any of them without a complete, valid configuration throws, so a
 * configured run can never fall back to unguarded children.
 *
 * The prologue above is one mechanism; preload TRANSPORT is a separate one. A
 * child that a test launches with a deliberately minimal, explicit environment
 * (rather than the inherited one) gets the guard through `childGuardEnv(runtime)`:
 * exactly the guard preload and the guard's own two settings, and nothing from
 * the parent environment. The transport depends on the runtime the CHILD really
 * executes, which the call site states from the concrete executable it spawns
 * (`executingRuntime()` for `process.execPath` or a byte copy of it, `shebangRuntime()`
 * for a generated script), never from the parent's runtime alone:
 *  - a Node child gets `NODE_OPTIONS=--import=<file: URL>`;
 *  - a Bun child gets `BUN_OPTIONS=--preload=<path>` (Bun does not read `NODE_OPTIONS`).
 * Any other or missing runtime throws, so no child is launched with a guess, and so
 * does a runtime the configured guard module does not declare it covers: a Bun child
 * is guarded only by an entry that declares `bun` (Node and Bun-native guards together).
 *
 * Only `node:` built-ins are imported, so plain Node can load this file too.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Environment variables that configure the bootstrap. */
export const CHILD_GUARD_ENV = {
  url: "LLMWIKI_TEST_CHILD_GUARD_URL",
  log: "LLMWIKI_TEST_CHILD_GUARD_LOG",
  denyExec: "LLMWIKI_TEST_CHILD_GUARD_DENY_EXEC",
  census: "LLMWIKI_TEST_CHILD_GUARD_CENSUS",
  runtimes: "LLMWIKI_TEST_CHILD_GUARD_RUNTIMES",
} as const;

/** Which generated process a prologue is embedded in (recorded in the census). */
export type ChildGuardRole = "fake" | "descendant";

/** A validated bootstrap configuration. */
export interface ChildGuardConfig {
  url: string;
  log: string;
  denyExec: string;
  census?: string;
  /** Runtimes the guard module covers; absent means `["node"]`. */
  runtimes?: ChildRuntime[];
}

/** Throw the bootstrap's configuration error. */
function invalid(reason: string): never {
  throw new Error(`child guard bootstrap: ${reason}`);
}

/** Require an absolute path value for one setting. */
function absolutePath(name: string, value: string | undefined): string {
  if (!value || !path.isAbsolute(value)) invalid(`${name} must be an absolute path`);
  return value;
}

/** Require a `file:` URL that names an existing guard module. */
function guardUrl(value: string | undefined): string {
  let file: string;
  try {
    file = fileURLToPath(value ?? "");
  } catch {
    return invalid(`${CHILD_GUARD_ENV.url} must be a file: URL`);
  }
  if (!existsSync(file)) invalid(`${CHILD_GUARD_ENV.url} names a missing guard module`);
  return value as string;
}

/** Require a non-empty colon-separated list of existing absolute executables. */
function deniedExecutables(value: string | undefined): string {
  const entries = (value ?? "").split(":");
  if (entries.some((entry) => !path.isAbsolute(entry) || !existsSync(entry))) {
    invalid(`${CHILD_GUARD_ENV.denyExec} must list existing absolute executables`);
  }
  return value as string;
}

/** Require a duplicate-free runtime list that includes `node` (the guard module always installs the Node guard). */
function coveredRuntimes(value: string): ChildRuntime[] {
  const runtimes = value.split(",").map((entry) => knownRuntime(entry));
  if (!runtimes.includes("node") || new Set(runtimes).size !== runtimes.length) {
    invalid(`${CHILD_GUARD_ENV.runtimes} must list node, and optionally bun, once each`);
  }
  return runtimes;
}

/**
 * Read the bootstrap configuration from the parent environment.
 *
 * @param env - The environment to read (the test process's by default).
 * @returns The validated configuration, or undefined when nothing is configured.
 * @throws When any setting is present but the configuration is incomplete or invalid.
 */
export function readChildGuardConfig(env: NodeJS.ProcessEnv = process.env): ChildGuardConfig | undefined {
  const names = Object.values(CHILD_GUARD_ENV);
  if (names.every((name) => env[name] === undefined)) return undefined;
  const census = env[CHILD_GUARD_ENV.census];
  const runtimes = env[CHILD_GUARD_ENV.runtimes];
  return {
    url: guardUrl(env[CHILD_GUARD_ENV.url]),
    log: absolutePath(CHILD_GUARD_ENV.log, env[CHILD_GUARD_ENV.log]),
    denyExec: deniedExecutables(env[CHILD_GUARD_ENV.denyExec]),
    ...(census === undefined ? {} : { census: absolutePath(CHILD_GUARD_ENV.census, census) }),
    ...(runtimes === undefined ? {} : { runtimes: coveredRuntimes(runtimes) }),
  };
}

/**
 * CommonJS statements that install the configured guard before a script's own code.
 *
 * @param config - The validated configuration, or undefined when disabled.
 * @param role - The generated process the prologue is embedded in.
 * @returns The prologue (newline-terminated), or "" when disabled so scripts stay unchanged.
 */
export function childGuardPrologue(config: ChildGuardConfig | undefined, role: ChildGuardRole): string {
  if (config === undefined) return "";
  const embedded = JSON.stringify({ ...config, role });
  return `;(() => {
  const config = ${embedded};
  const saved = { OFFLINE_GUARD_LOG: process.env.OFFLINE_GUARD_LOG, OFFLINE_GUARD_DENY_EXEC: process.env.OFFLINE_GUARD_DENY_EXEC };
  process.env.OFFLINE_GUARD_LOG = config.log;
  process.env.OFFLINE_GUARD_DENY_EXEC = config.denyExec;
  try {
    require(require("node:url").fileURLToPath(config.url));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  if (globalThis[Symbol.for("llmwiki.offline-guard")] === undefined) {
    throw new Error("child guard bootstrap: the configured offline guard did not install");
  }
  if (config.census) {
    require("node:fs").appendFileSync(config.census, JSON.stringify({ pid: process.pid, ppid: process.ppid, role: config.role }) + "\\n");
  }
})();
`;
}

/** The runtime a child process really executes; it selects the guard's preload transport. */
export type ChildRuntime = "node" | "bun";

/** The environment variable that carries preload flags for each runtime. */
const OPTIONS_VARIABLE = { node: "NODE_OPTIONS", bun: "BUN_OPTIONS" } as const;

/** Require a known runtime; anything else (including a missing one) fails closed. */
function knownRuntime(runtime: unknown): ChildRuntime {
  if (runtime !== "node" && runtime !== "bun") invalid(`unknown child runtime ${JSON.stringify(runtime)}`);
  return runtime as ChildRuntime;
}

/**
 * The runtime of this process, and so of a child that is `process.execPath` or a byte copy of it.
 *
 * @returns `"bun"` when Bun reports its version, otherwise `"node"`.
 */
export function executingRuntime(): ChildRuntime {
  return typeof process.versions.bun === "string" ? "bun" : "node";
}

/**
 * The runtime a script's `#!` line names, directly (`#!/path/to/node`) or through `env`.
 *
 * @param scriptPath - The script the child executes.
 * @returns The named runtime.
 * @throws When the first line names anything other than `node` or `bun`.
 */
export function shebangRuntime(scriptPath: string): ChildRuntime {
  const line = readFileSync(scriptPath, "utf8").split("\n", 1)[0];
  const match = /^#!\s*(?:\S*\/env\s+(?:-S\s+)?)?(\S+)/u.exec(line);
  return knownRuntime(match ? path.basename(match[1]) : undefined);
}

/**
 * The variable that carries preload flags for `runtime`.
 *
 * @param runtime - The child's runtime.
 * @returns `NODE_OPTIONS` or `BUN_OPTIONS`.
 */
export function runtimeOptionsVariable(runtime: ChildRuntime): "NODE_OPTIONS" | "BUN_OPTIONS" {
  return OPTIONS_VARIABLE[knownRuntime(runtime)];
}

/**
 * The flag that loads `module` before a `runtime` child's own code.
 *
 * @param runtime - The child's runtime.
 * @param module - The module, as an absolute path or a `file:` URL.
 * @returns `--import=<file: URL>` for Node, `--preload=<absolute path>` for Bun.
 */
export function preloadFlag(runtime: ChildRuntime, module: string): string {
  const file = module.startsWith("file:") ? fileURLToPath(module) : module;
  if (!path.isAbsolute(file)) invalid("a preload module must be an absolute path or a file: URL");
  // BUN_OPTIONS and NODE_OPTIONS are split into arguments at whitespace, and Bun documents no quoting for
  // BUN_OPTIONS, so a path that would need quoting is refused rather than passed as something else.
  if (UNQUOTABLE.test(file)) invalid("a preload module path must not contain whitespace, quotes or backslashes");
  return knownRuntime(runtime) === "node" ? `--import=${pathToFileURL(file).href}` : `--preload=${file}`;
}

/** Characters a preload path cannot contain inside an options variable without quoting. */
const UNQUOTABLE = /[\s"'\\]/u;

/**
 * An inherited options value followed by generated single-argument flags.
 *
 * The inherited value is opaque: it is kept byte for byte (its quoting, spacing and repeats are the
 * caller's and are never re-split or re-joined). Only the GENERATED flags are de-duplicated, by exact
 * equality among themselves; a generated flag that also appears inside the inherited text is appended
 * again rather than guessed away, because the guards are idempotent (their markers make a second load a
 * no-op) and reinterpreting opaque text could corrupt it.
 *
 * @param inherited - The inherited options value, or undefined.
 * @param flags - Generated flags, each one argument without whitespace (as {@link preloadFlag} makes them).
 * @returns The inherited text, then a single space, then each distinct generated flag separated by single spaces.
 * @throws When a generated flag is empty or contains whitespace.
 */
export function composeRuntimeOptions(inherited: string | undefined, ...flags: string[]): string {
  if (flags.some((flag) => flag === "" || /\s/u.test(flag))) invalid("a generated option flag must be one argument without whitespace");
  const generated = flags.filter((flag, index) => flags.indexOf(flag) === index);
  return [inherited, ...generated].filter((value) => value !== undefined && value !== "").join(" ");
}

/**
 * Environment entries that guard a child launched with an explicit environment.
 *
 * Spread these into a deliberately minimal child environment. They carry only
 * the configured guard (no parent variables, credentials or other preloads).
 *
 * @param runtime - The runtime the child really executes (required: there is no default).
 * @param config - The validated configuration (read from the parent environment by default,
 *   which throws when the configuration is incomplete or invalid).
 * @returns `{}` when unconfigured; otherwise exactly the runtime's options variable (the guard
 *   preload), `OFFLINE_GUARD_LOG` and `OFFLINE_GUARD_DENY_EXEC`.
 * @throws When `runtime` is unknown (even if no guard is configured), or when the configured guard
 *   module does not declare that it covers `runtime` (a Bun child needs the Bun-native guard too).
 */
export function childGuardEnv(runtime: ChildRuntime, config: ChildGuardConfig | undefined = readChildGuardConfig()): NodeJS.ProcessEnv {
  const variable = runtimeOptionsVariable(runtime);
  if (config === undefined) return {};
  if (!(config.runtimes ?? ["node"]).includes(runtime)) invalid(`the configured guard does not cover ${runtime} children`);
  return { [variable]: preloadFlag(runtime, config.url), OFFLINE_GUARD_LOG: config.log, OFFLINE_GUARD_DENY_EXEC: config.denyExec };
}

/**
 * A `runtime` options value that keeps every inherited preload and adds the given flags.
 *
 * Replacing the variable would silently drop preloads a run depends on (such as
 * its offline guard); appending keeps them, byte for byte, and still loads the test's own.
 *
 * @param runtime - The child's runtime (`NODE_OPTIONS` for Node, `BUN_OPTIONS` for Bun).
 * @param flags - Option flags to add after the inherited ones.
 * @returns The combined value.
 */
export function inheritedRuntimeOptions(runtime: ChildRuntime, ...flags: string[]): string {
  return composeRuntimeOptions(process.env[runtimeOptionsVariable(runtime)], ...flags);
}

/**
 * A `NODE_OPTIONS` value that keeps every inherited preload and adds the given flags (Node children).
 *
 * @param flags - Node option flags to add after the inherited ones.
 * @returns The combined value.
 */
export function inheritedNodeOptions(...flags: string[]): string {
  return inheritedRuntimeOptions("node", ...flags);
}
