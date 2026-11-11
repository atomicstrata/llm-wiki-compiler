/**
 * @file test/call-counting.ts
 * @description Count the filesystem calls and subprocess spawns this process
 * makes, for `bun run test:profile`.
 *
 * Wall time on a shared machine moves with whatever else is running. A count
 * of calls does not: the same code over the same fixture makes the same calls,
 * so a count is a cost a change can be held to.
 *
 * Two preloads install it: `test/call-counter.ts` in each test file, and
 * `test/call-counter-child.ts` in the CLI processes those tests spawn. Both
 * append one JSON line per test file or process to `<LLMWIKI_CALL_COUNTS>/<pid>.jsonl`.
 *
 * With `LLMWIKI_CALL_SITES=1` each call also records where it came from, so a
 * report can say which product code makes the calls. That costs a stack capture
 * per call; use it on a few files, not the suite.
 */

import fs from "node:fs";
import childProcess from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

/** One test file's or one child process's counts, as written to the output directory. */
export interface FileCallCounts {
  file: string;
  ops: Record<string, number>;
  sites?: Record<string, number>;
}

const SPAWN_FUNCTIONS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
const SITE_FRAMES = 3;
/** Shared primitives: a site names the product code that called into them. */
const PRIMITIVE_DIRECTORIES = ["utils/", "storage/"];

const ops = new Map<string, number>();
const sites = new Map<string, number>();
const recordSites = process.env.LLMWIKI_CALL_SITES === "1";
// A site looks past the primitives' own frames, so it needs a deeper stack.
if (recordSites) Error.stackTraceLimit = 40;
const appendFileSync = fs.appendFileSync;

/**
 * Count one call to `op`, and its call site when sites are recorded. A site is
 * the line that made the call plus the nearest callers outside the shared
 * primitives, so the report names product code, not `utils/`.
 */
function count(op: string): void {
  ops.set(op, (ops.get(op) ?? 0) + 1);
  if (!recordSites) return;
  const frames = (new Error().stack ?? "").split("\n").filter((line) => line.includes("/src/"))
    .map((line) => line.replace(/^.*\/src\//u, "").replace(/\)$/u, "").replace(/:\d+$/u, ""));
  const callers = frames.slice(1).filter((frame) => !PRIMITIVE_DIRECTORIES.some((dir) => frame.startsWith(dir)));
  const site = `${op} <- ${[frames[0], ...callers.slice(0, SITE_FRAMES - 1)].filter(Boolean).join(" < ") || "(test code)"}`;
  sites.set(site, (sites.get(site) ?? 0) + 1);
}

/** `original`, counting each call as `op`; what callers read off the function itself is kept. */
function counted(original: (...args: unknown[]) => unknown, op: string, customForm = true): (...args: unknown[]) => unknown {
  const wrapper = function (this: unknown, ...args: unknown[]) {
    count(op);
    return original.apply(this, args);
  };
  for (const key of Reflect.ownKeys(original)) {
    if (!(key in wrapper)) Object.defineProperty(wrapper, key, Object.getOwnPropertyDescriptor(original, key)!);
  }
  // `promisify(execFile)` calls the function's custom promisified form, not the
  // function. That form points at itself, so it is wrapped once and not followed.
  const custom = (original as { [promisify.custom]?: (...args: unknown[]) => unknown })[promisify.custom];
  if (customForm && typeof custom === "function") {
    Object.defineProperty(wrapper, promisify.custom, { value: counted(custom, op, false), configurable: true });
  }
  return wrapper;
}

/** Replace each named function on `owner` with its counted form. */
function wrap(owner: Record<string, unknown>, names: readonly string[], label: (name: string) => string): void {
  for (const name of names) {
    const original = owner[name];
    if (typeof original === "function") owner[name] = counted(original as (...args: unknown[]) => unknown, label(name));
  }
}

/** Lower-case own function names: the API, not its classes (`Stats`, `Dirent`, …). */
function apiFunctions(owner: object): string[] {
  return Object.keys(owner).filter((name) => /^[a-z]/u.test(name) && typeof (owner as Record<string, unknown>)[name] === "function");
}

/** Start counting this process's filesystem calls and spawns, each op named with `prefix`. */
export async function installCallCounting(prefix: string): Promise<void> {
  // File handles carry their own I/O (read, sync, stat, close): count it on the prototype.
  const probe = await fs.promises.open(import.meta.path, "r");
  const handlePrototype = Object.getPrototypeOf(probe) as Record<string, unknown>;
  await probe.close();
  wrap(fs as unknown as Record<string, unknown>, apiFunctions(fs).filter((name) => name !== "promises"), (name) => `${prefix}${name.replace(/Sync$/u, "")}`);
  wrap(fs.promises as unknown as Record<string, unknown>, apiFunctions(fs.promises), (name) => `${prefix}${name}`);
  wrap(handlePrototype, Object.getOwnPropertyNames(handlePrototype).filter((name) => name !== "constructor"), (name) => `${prefix}handle.${name}`);
  wrap(childProcess as unknown as Record<string, unknown>, SPAWN_FUNCTIONS, () => "spawn");
  wrap(Bun as unknown as Record<string, unknown>, ["spawn", "spawnSync"], () => "spawn");
}

/** Append this process's counts so far, attributed to the test `file`. */
export function recordCallCounts(file: string): void {
  const line: FileCallCounts = { file, ops: Object.fromEntries(ops) };
  if (recordSites) line.sites = Object.fromEntries(sites);
  appendFileSync(path.join(process.env.LLMWIKI_CALL_COUNTS!, `${process.pid}.jsonl`), `${JSON.stringify(line)}\n`);
}
