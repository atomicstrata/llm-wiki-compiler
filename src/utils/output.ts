/**
 * ANSI colored terminal output helpers.
 * Provides consistent styling for compilation progress, status messages,
 * and streaming token display.
 */

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
 * command. Callers are responsible for restoring the flag in a `finally`
 * block if they need partial silence.
 */
let quietMode = false;

/** Toggle the process-wide quiet flag. */
export function setQuiet(quiet: boolean): void {
  quietMode = quiet;
}

/** Print a status line with an icon. No-op while quiet mode is enabled. */
export function status(icon: string, message: string): void {
  if (quietMode) return;
  console.log(`${icon} ${message}`);
}

/** Print a section header. No-op while quiet mode is enabled. */
export function header(title: string): void {
  if (quietMode) return;
  console.log(`\n${BOLD}${title}${RESET}`);
  console.log(dim("─".repeat(Math.min(title.length + 4, 60))));
}

/**
 * Quiet-aware warning line (stderr-style notices). No-op while quiet.
 * Writes to stderr via `console.warn` — distinct from `status()`/`header()`,
 * which write progress to stdout via `console.log`.
 */
export function note(message: string): void {
  if (quietMode) return;
  console.warn(message);
}

/** Read the current quiet flag so callers can save/restore it. */
export function getQuiet(): boolean {
  return quietMode;
}
