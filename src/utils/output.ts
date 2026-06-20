/**
 * ANSI colored terminal output helpers.
 * Provides consistent styling for compilation progress, status messages,
 * and streaming token display.
 *
 * Quiet-mode is scoped per async call tree via AsyncLocalStorage so that
 * concurrent SDK calls (e.g. `Promise.all([wiki.lint(), wiki.search()])`)
 * never corrupt each other's quiet state. The process-wide `quietMode` flag
 * is preserved for the `quickstart --json` code path that calls `setQuiet`
 * directly; `isQuiet()` checks the scoped value first and falls back to the
 * global flag.
 *
 * Verbose-mode mirrors the quiet pattern: a process-wide `verboseMode` flag
 * plus an AsyncLocalStorage `verboseScope` for per-call-tree scoping. When
 * verbose is active, `verbose()` emits dimmed detail lines. Quiet always wins
 * — even if verbose is on, `isQuiet()` suppresses all output.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";

export function bold(text: string): string {
  return `${BOLD}${text}${RESET}`;
}

export function dim(text: string): string {
  return `${DIM}${text}${RESET}`;
}

export function success(text: string): string {
  return `${GREEN}${text}${RESET}`;
}

export function warn(text: string): string {
  return `${YELLOW}${text}${RESET}`;
}

export function info(text: string): string {
  return `${BLUE}${text}${RESET}`;
}

export function error(text: string): string {
  return `${RED}${text}${RESET}`;
}

export function source(text: string): string {
  return `${CYAN}${text}${RESET}`;
}

/**
 * Process-wide quiet flag. Toggled by `quickstart --json` so the
 * structured envelope is the only thing on stdout — every status/header
 * call short-circuits while the flag is set.
 *
 * Default is false, preserving byte-for-byte behaviour for every other
 * command. SDK callers should use `withQuiet` instead of mutating this
 * flag directly, to avoid concurrent call corruption.
 */
let quietMode = false;

/** ALS store scopes quietness to a single async call tree. */
const quietScope = new AsyncLocalStorage<boolean>();

/**
 * Run `fn` with quiet mode scoped to the current async call tree.
 * Concurrent calls are fully isolated — no global flag is mutated.
 * Returns whatever `fn` returns (preserves Promise for async functions).
 */
export function withQuiet<T>(fn: () => T): T {
  return quietScope.run(true, fn);
}

/**
 * Returns true if the current async context is quiet (via ALS scope)
 * or the process-wide quiet flag is set. The scoped value takes priority.
 */
export function isQuiet(): boolean {
  return quietScope.getStore() ?? quietMode;
}

/** Toggle the process-wide quiet flag. */
export function setQuiet(quiet: boolean): void {
  quietMode = quiet;
}

/** Print a status line with an icon. No-op while quiet mode is enabled. */
export function status(icon: string, message: string): void {
  if (isQuiet()) return;
  console.log(`${icon} ${message}`);
}

/** Print a section header. No-op while quiet mode is enabled. */
export function header(title: string): void {
  if (isQuiet()) return;
  console.log(`\n${BOLD}${title}${RESET}`);
  console.log(dim("─".repeat(Math.min(title.length + 4, 60))));
}

/**
 * Quiet-aware warning line (stderr-style notices). No-op while quiet.
 * Writes to stderr via `console.warn` — distinct from `status()`/`header()`,
 * which write progress to stdout via `console.log`.
 */
export function note(message: string): void {
  if (isQuiet()) return;
  console.warn(message);
}

/** Read the current process-wide quiet flag. */
export function getQuiet(): boolean {
  return quietMode;
}

/**
 * Process-wide verbose flag. Toggled by `--verbose` or `LLMWIKI_VERBOSE=1`.
 * SDK callers should use `withVerbose` instead of mutating this flag directly.
 */
let verboseMode = false;

/** ALS store scopes verbose to a single async call tree. */
const verboseScope = new AsyncLocalStorage<boolean>();

/**
 * Run `fn` with verbose mode scoped to the current async call tree.
 * Concurrent calls are fully isolated — no global flag is mutated.
 */
export function withVerbose<T>(fn: () => T): T {
  return verboseScope.run(true, fn);
}

/**
 * Returns true if the current async context is verbose (via ALS scope)
 * or the process-wide verbose flag is set. The scoped value takes priority.
 */
export function isVerbose(): boolean {
  return verboseScope.getStore() ?? verboseMode;
}

/** Toggle the process-wide verbose flag. */
export function setVerbose(v: boolean): void {
  verboseMode = v;
}

/**
 * Print a dimmed detail line when verbose mode is on. No-op when quiet or
 * verbose is off. Quiet always wins over verbose.
 */
export function verbose(message: string): void {
  if (!isVerbose() || isQuiet()) return;
  console.log(dim(`  · ${message}`));
}
