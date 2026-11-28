/**
 * @file test/scale-measure/fs-observer.ts
 * @description A PROCESS-WIDE file-system observer for measurement children.
 *
 * Segment counters see only the indexed stores. To report ALL the work an
 * operation does (including incumbent global reads such as the live-page
 * collection a vector refresh makes), this patches the `node:fs` promise and
 * sync entry points the code uses and re-syncs the builtin ESM bindings, then
 * tallies INSTRUMENTED fs-API calls (not physical device I/O or every
 * syscall: handle stats and directory iteration are not covered): opens,
 * bytes read and written, directory listings and stats per
 * AREA of the project: `indexed` (`.llmwiki/indexed/`), `legacy` (the
 * incumbent single-file stores kept as backups), `corpus` (`wiki/`,
 * `sources/`) and `other` (the rest of the project, and anything outside it).
 * Observation only: every call is forwarded unchanged.
 */

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

/** The project areas reads are tallied under. */
type FsArea = "indexed" | "legacy" | "corpus" | "other";

/** One area's tally. */
interface FsTally { opens: number; bytesRead: number; bytesWritten: number; listings: number; stats: number }

/** Incumbent single-file stores, relative to the project root. */
const LEGACY = [".llmwiki/embeddings.json", ".llmwiki/embeddings.bin", "wiki/graph/events.jsonl", "wiki/graph/relations.jsonl", ".llmwiki/workspaces/"];

/** Tallies per area, reset by the caller between runs. */
export const fsTallies: Record<FsArea, FsTally> = { indexed: blank(), legacy: blank(), corpus: blank(), other: blank() };

/** An empty tally. */
function blank(): FsTally { return { opens: 0, bytesRead: 0, bytesWritten: 0, listings: 0, stats: 0 }; }

/** Zero every tally. */
export function resetFsTallies(): void {
  for (const area of Object.keys(fsTallies) as FsArea[]) fsTallies[area] = blank();
}

let projectRoot = "/";

/** The area of `target` (a path, URL or anything else). */
function areaOf(target: unknown): FsArea {
  if (typeof target !== "string" && !(target instanceof URL)) return "other";
  const relative = path.relative(projectRoot, typeof target === "string" ? path.resolve(target) : target.pathname);
  if (relative.startsWith("..")) return "other";
  if (relative.startsWith(".llmwiki/indexed")) return "indexed";
  if (LEGACY.some((prefix) => relative === prefix || (prefix.endsWith("/") && relative.startsWith(prefix)))) return "legacy";
  return relative.startsWith("wiki/") || relative.startsWith("sources/") ? "corpus" : "other";
}

/** Byte length of a read or write result. */
function sizeOf(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return 0;
}

/** Wrap `owner[name]` so each call tallies `field` for the area of its first argument. */
function tallyCalls(owner: Record<string, unknown>, name: string, field: keyof FsTally, measure?: (result: unknown, args: unknown[]) => number): void {
  const original = owner[name] as (...args: unknown[]) => unknown;
  owner[name] = function patched(this: unknown, ...args: unknown[]): unknown {
    const area = areaOf(args[0]);
    const result = original.apply(this, args);
    const add = (value: unknown): unknown => { fsTallies[area][field] += measure === undefined ? 1 : measure(value, args); return value; };
    return result instanceof Promise ? result.then(add) : add(result);
  };
}

/** The area each open handle belongs to. */
const handleAreas = new WeakMap<object, FsArea>();

/** Patch the FileHandle prototype (reached through the first opened handle) to tally reads and writes. */
function patchHandles(handle: object): void {
  const proto = Object.getPrototypeOf(handle) as Record<string, unknown> & { __measured?: boolean };
  if (proto.__measured === true) return;
  proto.__measured = true;
  const wrap = (name: string, field: "bytesRead" | "bytesWritten", measure: (result: unknown) => number) => {
    const original = proto[name] as (...args: unknown[]) => Promise<unknown>;
    proto[name] = async function patched(this: object, ...args: unknown[]): Promise<unknown> {
      const result = await original.apply(this, args);
      fsTallies[handleAreas.get(this) ?? "other"][field] += measure(result);
      return result;
    };
  };
  wrap("read", "bytesRead", (result) => (result as { bytesRead?: number }).bytesRead ?? 0);
  wrap("readFile", "bytesRead", sizeOf);
  wrap("write", "bytesWritten", (result) => (result as { bytesWritten?: number }).bytesWritten ?? 0);
  const writeFile = proto.writeFile as (...args: unknown[]) => Promise<unknown>;
  proto.writeFile = async function patched(this: object, ...args: unknown[]): Promise<unknown> {
    const result = await writeFile.apply(this, args);
    fsTallies[handleAreas.get(this) ?? "other"].bytesWritten += sizeOf(args[0]);
    return result;
  };
}

/** Patch `fs.promises.open` so every handle is attributed to its area. */
function patchOpen(): void {
  const promises = fs.promises as unknown as Record<string, unknown>;
  const original = promises.open as (...args: unknown[]) => Promise<object>;
  promises.open = async (...args: unknown[]) => {
    const handle = await original(...args);
    const area = areaOf(args[0]);
    fsTallies[area].opens += 1;
    handleAreas.set(handle, area);
    patchHandles(handle);
    return handle;
  };
}

/** Install the observer for the project at `root` (once per process). */
export function installFsObserver(root: string): void {
  projectRoot = path.resolve(root);
  const promises = fs.promises as unknown as Record<string, unknown>;
  const sync = fs as unknown as Record<string, unknown>;
  patchOpen();
  tallyCalls(promises, "readFile", "bytesRead", sizeOf);
  tallyCalls(sync, "readFileSync", "bytesRead", sizeOf);
  tallyCalls(promises, "writeFile", "bytesWritten", (_result, args) => sizeOf(args[1]));
  for (const name of ["readdir", "opendir"]) tallyCalls(promises, name, "listings");
  tallyCalls(sync, "readdirSync", "listings");
  for (const name of ["stat", "lstat", "realpath"]) tallyCalls(promises, name, "stats");
  for (const name of ["statSync", "lstatSync", "existsSync"]) tallyCalls(sync, name, "stats");
  syncBuiltinESMExports();
}
