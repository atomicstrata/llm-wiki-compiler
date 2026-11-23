/**
 * @file test/batch/helpers.ts
 * @description Fixtures for the batch compile tests: TWIN projects with the
 * same sources (one ordinary local project compiled by the incumbent body,
 * one `local-indexed` project whose segmented compile state is ready and is
 * compiled by the batch body), a DETERMINISTIC provider double (no network),
 * and a normalized snapshot of everything a compile leaves behind, so a test
 * asserts the batch body leaves exactly what the incumbent leaves.
 *
 * THE DOUBLE. A test-only provider (`../helpers/deterministic-provider.ts`),
 * installed through the existing provider-override seam; no production code
 * knows it. Extraction answers with the concepts a source names on its
 * `Concepts:` line; `!fail` or no named concept answers unusable text (an
 * extraction failure, which both bodies retry next run); a page or seed
 * generation answers with a body derived from a digest of its WHOLE prompt
 * (system and messages), so any difference in what the two bodies send the
 * model (link targets, related context, merged sources, order) shows up as a
 * difference in the pages. Until a test installs the double, every model
 * call THROWS, so a refusal test also proves that nothing was sent.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import type { BatchPhase } from "../../src/compiler/batch/contracts.js";
import { BatchRun } from "../../src/compiler/batch/run-store.js";
import type { BatchRunOptions } from "../../src/compiler/batch/contracts.js";
import { compileAndReport as compileAndReportUnderEnvironment } from "../../src/compiler/index.js";
import { prepareExpectedScaleWith, setExpectedScaleWith } from "../../src/scale/transition.js";
import { readState } from "../../src/utils/state.js";
import type { LLMMessage } from "../../src/utils/provider.js";
import type { CompileOptions, CompileResult } from "../../src/utils/types.js";
import { CSTATE, stepsFor } from "../cstate/helpers.js";
import { DeterministicProvider, withProvider } from "../helpers/deterministic-provider.js";

/** A twin pair: the incumbent project and the segmented one. */
export interface Twin { readonly plain: string; readonly segmented: string }

/** Write `sources` (name → text) into `root`'s sources directory. */
export async function writeSources(root: string, sources: Readonly<Record<string, string>>): Promise<void> {
  await mkdir(path.join(root, "sources"), { recursive: true });
  for (const [name, text] of Object.entries(sources)) {
    await mkdir(path.dirname(path.join(root, "sources", name)), { recursive: true });
    await writeFile(path.join(root, "sources", name), text);
  }
}

/** A source naming its concepts. */
export const sourceNaming = (title: string, ...concepts: string[]): string => `# ${title}\n\n${title} discusses things.\n\nConcepts: ${concepts.join(", ")}\n`;

/** A fresh project root with the standard directories. */
async function freshRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `llmwiki-batch-${label}-`));
  for (const dir of ["sources", "wiki/concepts", "wiki/queries", ".llmwiki"]) await mkdir(path.join(root, dir), { recursive: true });
  return root;
}

/** Make `root` a `local-indexed` project whose segmented compile state is ready. */
export async function segment(root: string): Promise<void> {
  const set = await setExpectedScaleWith(stepsFor(root), { request: { documents: 8_000 } });
  expect([set.readiness, set.record?.active.architecture]).toEqual(["ready", "local-indexed"]);
  const prepared = await prepareExpectedScaleWith(stepsFor(root), { capabilities: [CSTATE] });
  expect(prepared.readiness).toBe("ready");
}

/** Twin projects holding the same `sources`. */
export async function makeTwin(sources: Readonly<Record<string, string>>): Promise<Twin> {
  const plain = await freshRoot("plain");
  const segmented = await freshRoot("segmented");
  await writeSources(plain, sources);
  await writeSources(segmented, sources);
  await segment(segmented);
  return { plain, segmented };
}

/** The `Concepts:` line an extraction prompt's source carries, if any. */
function conceptsLine(system: string): string | undefined {
  return /^Concepts: (.*)$/m.exec(system.split("--- SOURCE DOCUMENT ---").pop() ?? "")?.[1];
}

/** The concepts an extraction prompt's source names. */
function namedConcepts(line: string | undefined): string[] {
  if (line === undefined || line.includes("!fail")) return [];
  return line.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
}

/** An unusable extraction answer: a failure the compiler retries. */
const FAILED_EXTRACTION = "Extraction unavailable for this document.";

/** Whether an extracted concept is new to the wiki; by default every one is. */
type IsNew = (concept: string) => boolean;

/** The extraction tool answer for one prompt. */
function extraction(system: string, isNew: IsNew): string {
  const concepts = namedConcepts(conceptsLine(system));
  if (concepts.length === 0) return FAILED_EXTRACTION;
  return JSON.stringify({ concepts: concepts.map((concept) => ({ concept, summary: `${concept} summary.`, is_new: isNew(concept), tags: [concept.split(" ")[0]!.toLowerCase()] })) });
}

/** A page body derived from the whole prompt (its time stamps normalized: twins wrote their pages at different times). */
function pageBody(system: string, messages: LLMMessage[]): string {
  const digest = createHash("sha256").update(normalized(system)).update(normalized(JSON.stringify(messages))).digest("hex").slice(0, 16);
  return `Body ${digest}.\n\nSee also the related ideas.`;
}

/** The provider the next compile runs under: one that throws on any call until a test installs the double. */
let activeProvider = new DeterministicProvider();

/**
 * Install the deterministic double for the following compiles; returns the call log.
 * @param isNew - Which extracted concepts are reported as new to the wiki (default: all).
 */
export function stubDeterministicProvider(isNew: IsNew = () => true): { extractions: string[]; pages: number } {
  const calls = { extractions: [] as string[], pages: 0 };
  activeProvider = new DeterministicProvider({
    extract: (system) => { calls.extractions.push(system); return extraction(system, isNew); },
    page: (system, messages) => { calls.pages += 1; return pageBody(system, messages); },
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  return calls;
}

/** How many model calls of any kind the active provider has received. */
export function modelCallCount(): number {
  return activeProvider.totalCalls;
}

/** The compile under the active test provider (the throwing one when no double is installed). */
export function compileUnderTestProvider(root: string, options: CompileOptions & BatchRunOptions = {}): Promise<CompileResult> {
  return withProvider(activeProvider, () => compileAndReportUnderEnvironment(root, options));
}

/** The compile options every batch-resume step runs with: a batch compile refreshes no embeddings. */
const RESUME_OPTIONS = { embeddings: false } as const;
/** The options a batch compile (and a twin's incumbent compile beside it) runs with: no embeddings refresh. */
export const EMBEDDINGS_OFF = RESUME_OPTIONS;
/** Each durable segment commit costs ~1.2 s on the loaded test volume, so a twin case with several compiles needs minutes. */
export const TWIN_CASE_TIMEOUT_MS = 900_000;

/** Fail the first advance into `phase` (the run's checkpoint before it is kept; the advance itself is lost). */
export function failAdvanceInto(phase: BatchPhase): void {
  const advance = BatchRun.prototype.advance;
  let failed = false;
  vi.spyOn(BatchRun.prototype, "advance").mockImplementation(async function (this: BatchRun, next, cursor) {
    if (next === phase && !failed) { failed = true; throw new Error(`injected failure before ${phase}`); }
    return advance.call(this, next, cursor);
  });
}

/**
 * Compile the plain twin, interrupt the segmented twin's compile (batches of
 * one) before `phase`, resume it, and expect it to finish and leave exactly
 * what the plain twin leaves.
 */
export async function expectResumeParity(twin: Twin, phase: BatchPhase): Promise<void> {
  stubDeterministicProvider();
  await compileUnderTestProvider(twin.plain, RESUME_OPTIONS);
  failAdvanceInto(phase);
  await expect(compileUnderTestProvider(twin.segmented, { batchSize: 1, ...RESUME_OPTIONS })).rejects.toThrow(`injected failure before ${phase}`);
  const resumed = await compileUnderTestProvider(twin.segmented, RESUME_OPTIONS);
  expect(resumed).toMatchObject({ mode: "batch", batch: { phase: "done" } });
  expect(await snapshotOf(twin.segmented)).toEqual(await snapshotOf(twin.plain));
}

/** Start a test with NO double installed: any model call throws until `stubDeterministicProvider` runs. */
export function useTestProvider(): void {
  activeProvider = new DeterministicProvider();
}

/** Register a twin test file's provider environment and cleanup: mocks restored and the current twin (from `current`) removed after each test. */
export function useTwinFixture(current: () => Twin | undefined): void {
  beforeEach(() => useTestProvider());
  afterEach(async () => {
    vi.restoreAllMocks();
    const twin = current();
    for (const root of [twin?.plain, twin?.segmented]) if (root) await rm(root, { recursive: true, force: true });
  });
}

/** Page text with run-dependent stamps (times) replaced. */
const normalized = (text: string): string => text
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>");

/** Every page of one wiki directory, normalized, by name. */
async function pagesOf(root: string, rel: string): Promise<Record<string, string>> {
  const names = await readdir(path.join(root, rel)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  const pages: Record<string, string> = {};
  for (const name of names.sort()) if (name.endsWith(".md")) pages[name] = normalized(await readFile(path.join(root, rel, name), "utf-8"));
  return pages;
}

/** The compile state, without its run-dependent stamps. */
async function stateOf(root: string): Promise<unknown> {
  const state = await readState(root);
  const sources = Object.entries(state.sources).map(([file, entry]) => [file, { ...entry, compiledAt: "<time>" }]);
  return { ...state, sources };
}

/** Compile both twins (the segmented one in batches of `batchSize`; embeddings off, which a batch compile requires) and expect identical outcomes. */
export async function compileTwins(twin: Twin, batchSize: number): Promise<void> {
  stubDeterministicProvider();
  const plain = await compileUnderTestProvider(twin.plain, { embeddings: false });
  const batch = await compileUnderTestProvider(twin.segmented, { batchSize, embeddings: false });
  expect(batch).toMatchObject({ mode: "batch", compiled: plain.compiled, skipped: plain.skipped, deleted: plain.deleted });
  expect(await snapshotOf(twin.segmented)).toEqual(await snapshotOf(twin.plain));
}

/** Generated concept and saved-query pages, index, MOC and state that the two compile paths must agree on. */
export async function snapshotOf(root: string): Promise<unknown> {
  const read = async (rel: string): Promise<string> => {
    try { return normalized(await readFile(path.join(root, rel), "utf-8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "<absent>"; throw error; }
  };
  return {
    concepts: await pagesOf(root, "wiki/concepts"), queries: await pagesOf(root, "wiki/queries"),
    index: await read("wiki/index.md"), moc: await read("wiki/MOC.md"), state: await stateOf(root),
  };
}
