/**
 * @file test/storage/embedding-binding-doubles.ts
 * @description The embedding binding suites' shared environment, observers and
 * memory doubles. Each suite mints real projects, copies what the disk left, and
 * re-runs the same steps over these doubles to require literal parity.
 *
 * - {@link withEmbeddingEnvironment}: the stubbed configuration, frozen clock and
 *   offline provider a refresh or writer step runs under, restored afterwards;
 *   {@link restoreClockAfterSuite} returns the real clock once the suite ends, and
 *   {@link recordingInto} keeps one step's provider calls beside the shared log.
 * - {@link observeStatus}: one step settled once, with the status lines it printed;
 *   {@link expectMarkerParity} requires a memory run to match the disk's.
 * - {@link markersOnDisk} / {@link markersOfCopy}: whether `.llmwiki` exists and
 *   each present marker's text, read from a real root or from a copy.
 * - {@link privateDirLeaves}: what a real private directory holds, leaf by leaf.
 * - {@link privateLeafStoreOf}: ONE in-memory private directory seeded from a
 *   copy, with the stored-embedding reads and writes over it.
 * - {@link copiedPageReadsOf}: the live page reads over a copy.
 *
 * The doubles stand in for mechanisms only. Confinement, no-follow and
 * durability stay in the disk adapters and are proven by the disk runs; the
 * memory runs prove the bodies' decisions and order.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, vi, setSystemTime } from "bun:test";
import { restoreEnv, restoreGlobals, stubEnv, stubGlobal } from "../stubs.js";
import * as transport from "../../src/utils/embedding-provider.js";
import type { EmbeddingPageReads } from "../../src/utils/embeddings-pages.js";
import type { StoredEmbeddingReads, StoredEmbeddingWrites } from "../../src/utils/embeddings-storage.js";
import { LLMWIKI_DIR } from "../../src/utils/constants.js";
import * as output from "../../src/utils/output.js";
import type { Copy, Minted } from "./copied-project.js";
import { failureText } from "./scenario-mint.js";

/** What a step's environment switches on, the frozen instant, and which witness forbids the network. */
export interface EmbeddingEnvironment { enabled: boolean; strict: boolean; fail: boolean; at: string; witness: string }

/** Run `body` under the stubbed configuration, frozen clock and stub provider, recording provider calls AS THEY HAPPEN; restore all of it after. */
export async function withEmbeddingEnvironment<T>(env: EmbeddingEnvironment, record: (call: string) => void, body: () => Promise<T>): Promise<T> {
  const stubs = { LLMWIKI_EMBEDDINGS: env.enabled ? "on" : "off", LLMWIKI_EMBED_STRICT: env.strict ? "on" : "off", LLMWIKI_PROVIDER: "openai",
    LLMWIKI_EMBEDDING_PROVIDER: "openai", LLMWIKI_EMBEDDING_MODEL: "offline-embed", OPENAI_API_KEY: "test-key", LLMWIKI_BINARY_EMBEDDINGS: "" };
  for (const [name, value] of Object.entries(stubs)) stubEnv(name, value);
  stubGlobal("fetch", () => { throw new Error(`network forbidden in the ${env.witness} witness`); });
  setSystemTime(new Date(env.at));
  const embedBatch = async (texts: string[]) => {
    record(`embed ${texts.length}`);
    if (env.fail) throw new Error("provider refused");
    return texts.map(() => [0.5, 0.5]);
  };
  const provider = vi.spyOn(transport, "getEmbeddingProvider").mockReturnValue(
    { embed: async (text: string) => (await embedBatch([text]))[0], embedBatch } as unknown as ReturnType<typeof transport.getEmbeddingProvider>);
  try { return await body(); } finally { provider.mockRestore(); restoreGlobals(); restoreEnv(); }
}

/**
 * Return the real clock when the suite ends. Each {@link withEmbeddingEnvironment}
 * pins `Date` with `setSystemTime` (Bun's fake clock needs no fake timers), so
 * only the suite-wide reset is left to register here.
 */
export function restoreClockAfterSuite(): void {
  afterAll(() => { setSystemTime(); });
}

/** One step's call record: `record` keeps each call in this step's `calls` and in the suite's shared `log`. */
export function recordingInto(log: string[]): { calls: string[]; record: (call: string) => void } {
  const calls: string[] = [];
  return { calls, record: (call) => { calls.push(call); log.push(call); } };
}

/** One step's settled outcome and the status lines it printed, ANSI-stripped. */
export interface Observed { outcome: string; lines: string[] }

/** Observe one step exactly once: settle it once and capture its status lines, then restore the spy. */
export async function observeStatus(run: () => Promise<unknown>): Promise<Observed> {
  const lines: string[] = [];
  const status = vi.spyOn(output, "status").mockImplementation((icon, message) => { lines.push(`${icon} ${message.replace(/\x1b\[[0-9;]*m/g, "")}`); });
  try {
    const outcome = await run().then((value) => JSON.stringify(value) ?? "undefined", failureText);
    return { outcome, lines };
  } finally {
    status.mockRestore();
  }
}

/** Whether `.llmwiki` exists, and each present marker's text by its project-relative path. */
export interface StoredMarkers { privateDir: boolean; files: Record<string, string> }

/** What the disk holds: whether `.llmwiki` exists, and each present marker's text. */
export async function markersOnDisk(root: string, markers: readonly string[]): Promise<StoredMarkers> {
  const privateDir = await stat(path.join(root, LLMWIKI_DIR)).then((found) => found.isDirectory(), () => false);
  const files: Record<string, string> = {};
  for (const rel of markers) {
    const text = await readFile(path.join(root, rel), "utf8").catch(() => null);
    if (text !== null) files[rel] = text;
  }
  return { privateDir, files };
}

/** The same view of a copy: whether it listed `.llmwiki`, and each marker it holds. */
const markersOfCopy = (copy: Copy, markers: readonly string[]): StoredMarkers =>
  ({ privateDir: copy.listings.has(LLMWIKI_DIR), files: Object.fromEntries(markers.flatMap((rel) => copy.files.has(rel) ? [[rel, copy.files.get(rel)!]] : [])) });

/** Require a memory run to observe what the disk observed, and to leave the marker state the disk left. */
export function expectMarkerParity(one: Minted<{ observed: Observed[] }>, observed: Observed[], stored: StoredMarkers, markers: readonly string[]): void {
  expect(observed).toEqual(one.onDisk.observed);
  expect(stored).toEqual(markersOfCopy(one.copy, markers));
}

/** Each private leaf as an outcome shows it, by name; `null` when there is no private directory. */
export type Leaves = Record<string, string> | null;
/** How a suite shows one regular leaf's bytes. */
export type ShowLeaf = (name: string, bytes: Buffer) => string;

/** What the real private directory holds: each regular leaf as `show` renders it, or another entry's kind. */
export async function privateDirLeaves(root: string, show: ShowLeaf): Promise<Leaves> {
  const entries = await readdir(path.join(root, LLMWIKI_DIR), { withFileTypes: true }).catch(() => null);
  if (entries === null) return null;
  const held: Record<string, string> = {};
  for (const one of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    held[one.name] = one.isFile() ? show(one.name, await readFile(path.join(root, LLMWIKI_DIR, one.name))) : one.isDirectory() ? "directory" : "other";
  }
  return held;
}

/** One in-memory private directory and the stored-embedding mechanisms over it. */
export interface PrivateLeafStore {
  /** Each leaf by name: a regular leaf's bytes, or another entry's kind. */
  held: Map<string, Buffer | "directory" | "other">;
  isCreated(): boolean;
  markCreated(): void;
  put(name: string, content: string | Uint8Array): void;
  reads: StoredEmbeddingReads;
  writes: StoredEmbeddingWrites;
  leaves(show: ShowLeaf): Promise<Leaves>;
}

/** How the store double logs and fails: each call is logged as `${prefix}<call>`; `refusal` rejects every replacement after it is logged. */
export interface PrivateLeafOptions { prefix: string; dir: string; refusal?: Error }

/** ONE private directory seeded from `copy`'s `.llmwiki` listing, with the store's reads and writes over it, each call logged first. */
export function privateLeafStoreOf(copy: Copy, log: string[], options: PrivateLeafOptions): PrivateLeafStore {
  const { prefix, dir: privateDir, refusal } = options;
  let created = copy.listings.has(LLMWIKI_DIR);
  const held = new Map<string, Buffer | "directory" | "other">((copy.listings.get(LLMWIKI_DIR) ?? []).map((one) => [one.name,
    one.kind === "file" ? Buffer.from(copy.files.get(`${LLMWIKI_DIR}/${one.name}`)!, "utf-8") : one.kind === "directory" ? "directory" : "other"]));
  const put = (name: string, content: string | Uint8Array): void => { held.set(name, typeof content === "string" ? Buffer.from(content, "utf-8") : Buffer.from(content)); };
  const resolvePrivateDir = async () => { log.push(`${prefix}dir`); return created ? privateDir : null; };
  const leafKind = async (_dir: string, name: string) => {
    log.push(`${prefix}kind ${name}`);
    const leaf = held.get(name);
    return leaf === undefined ? "absent" as const : Buffer.isBuffer(leaf) ? "regular" as const : "other" as const;
  };
  const reads: StoredEmbeddingReads = { resolvePrivateDir, leafKind, readLeafBytes: async (_dir, name, maxBytes) => {
    log.push(`${prefix}read ${name}`); const bytes = held.get(name) as Buffer; return bytes.byteLength > maxBytes ? null : bytes; } };
  const writes: StoredEmbeddingWrites = { resolvePrivateDir, leafKind,
    createPrivateDir: async () => { log.push(`${prefix}create`); created = true; },
    replaceLeaf: async (relPath, content) => {
      log.push(`${prefix}replace ${relPath}`);
      if (refusal) throw refusal;
      put(path.posix.relative(LLMWIKI_DIR, relPath), content);
    } };
  const leaves = async (show: ShowLeaf): Promise<Leaves> => (created
    ? Object.fromEntries([...held].sort(([a], [b]) => a.localeCompare(b)).map(([name, leaf]) => [name, Buffer.isBuffer(leaf) ? show(name, leaf) : leaf]))
    : null);
  return { held, isCreated: () => created, markCreated: () => { created = true; }, put, reads, writes, leaves };
}

/** What a suite observes of the page reads: a hook before each directory resolution and stat, and stat failures to inject by path. */
export interface PageReadHooks { onDirectory?(relDir: string): void; onStat?(relPath: string): void; statCodes?: Record<string, string> }

/** The live page reads over a copied tree rooted at `memRoot`, POSIX project-relative. */
export function copiedPageReadsOf(copy: Copy, memRoot: string, hooks: PageReadHooks = {}): EmbeddingPageReads {
  const relOf = (locator: string): string => path.posix.relative(memRoot, locator);
  return {
    projectDirectory: async () => memRoot,
    confinedDirectory: async (project, relDir) => { hooks.onDirectory?.(relDir); return copy.listings.has(relDir) ? path.posix.join(project, relDir) : null; },
    listNames: async (directory) => copy.listings.get(relOf(directory))!.map((found) => found.name),
    readConfinedEntry: async (directory, name) => {
      const text = copy.files.get(`${relOf(directory)}/${name}`);
      return text === undefined ? { dropped: "unreadable" } : { content: text };
    },
    isRegularFile: async (relPath) => {
      hooks.onStat?.(relPath);
      const code = hooks.statCodes?.[relPath];
      if (code !== undefined) throw Object.assign(new Error(code), { code });
      if (copy.files.has(relPath)) return true;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };
}
