/**
 * @file test/scale-measure/run.ts
 * @description The measurement driver. For each requested variant and size
 * it builds a corpus phase by phase and then runs every measured operation,
 * EACH in a fresh child process (`./child.ts`, bundled once from the current
 * source tree), and appends every child's JSON to one results file as it
 * goes (a partial run keeps what it measured). It records the environment
 * (hardware, Node, git HEAD and a digest of the uncommitted tree) and, after
 * each build, the actual bytes on disk per indexed store and per area.
 *
 * Children get only the offline provider environment (no keys, no network:
 * see `./embedding-double.ts`). To run it outside vitest, bundle this file
 * the way `bundleChild` bundles children and run the bundle from the
 * repository root: `node <bundle> <out.json> <variant>:<docs>[,...] [build|ops|all] [corpus-dir]`
 * (build the corpora, possibly concurrently, then time the operations once
 * the machine is quiet).
 */

import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { bundleChild, childEnd, startChild, type ChildEnd } from "../helpers-child-process.js";
import { diskBytes, environment, resultsRecorder } from "./environment.js";
import type { ChildRequest } from "./child.js";
import { MEASURE_VECTOR_DIMENSIONS, type CorpusShape } from "./corpus.js";
import { MEASURE_ENV } from "./embedding-double.js";

/** One variant: its corpus shape (by size), build phases and operations. */
interface Variant {
  readonly shape: (docs: number) => CorpusShape;
  readonly phases: readonly string[];
  readonly ops: readonly string[];
  /** Extra child environment. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Vector width of every measured corpus. */
// Before any operation mutates the corpus: the offline compile, then the synthetic processed-source checkpoint
// (a BUILD child, never timed as compilation), then the real no-op compile. `phase:` names a build child.
const ALL_OPS = [
  "compile-offline", "phase:noop-checkpoint", "compile-noop", "list-pages", "list-sources", "catalog-status", "identity-lookup", "ingest-one", "event-append", "event-page", "event-find-mutation",
  "relation-append-new", "relation-append-dedupe", "relation-update", "opcat-append-lookup", "vector-search", "vector-update-one",
  "sync-after-edit", "event-verify-full", "relations-materialize", "status", "verify-all",
];
// The standard path has no catalog, segmented history or indexed verification; its operation-catalog lookup is not segmented either.
/** An operation-list entry naming a build child rather than a timed operation. */
const PHASE_PREFIX = "phase:";
const STANDARD_OPS = ALL_OPS.filter((op) => ![
  "catalog-status", "identity-lookup", "event-page", "event-find-mutation", "sync-after-edit", "event-verify-full", "verify-all", "opcat-append-lookup",
].includes(op));
const BUILD = ["init", "sources", "pages", "vectors", "events", "relations", "opcat", "compile"];

/** The measured variants. */
const VARIANTS: Record<string, Variant> = {
  // Vectors per document = 1 page vector + chunksPerDoc: 2 per document here, 10 in the high-multiplicity variant.
  indexed: { shape: (docs) => ({ docs, chunksPerDoc: 1, eventsPerDoc: 10, relationsPerDoc: 5, expectedDocuments: 10_000 }), phases: BUILD, ops: ALL_OPS },
  "indexed-hi": { shape: (docs) => ({ docs, chunksPerDoc: 9, eventsPerDoc: 0, relationsPerDoc: 0, expectedDocuments: 10_000 }), phases: ["init", "pages", "vectors"], ops: ["vector-search", "vector-update-one", "verify-all"] },
  standard: { shape: (docs) => ({ docs, chunksPerDoc: 1, eventsPerDoc: 10, relationsPerDoc: 5, expectedDocuments: 0 }), phases: BUILD, ops: STANDARD_OPS, env: { LLMWIKI_BINARY_EMBEDDINGS: "1" } },
  "standard-migrate": { shape: (docs) => ({ docs, chunksPerDoc: 1, eventsPerDoc: 10, relationsPerDoc: 5, expectedDocuments: 0 }), phases: [...BUILD, "migrate"], ops: ["list-pages", "event-append", "vector-search", "verify-all"], env: { LLMWIKI_BINARY_EMBEDDINGS: "1" } },
  calibration: { shape: (docs) => ({ docs, chunksPerDoc: 0, eventsPerDoc: 0, relationsPerDoc: 0, expectedDocuments: 0 }), phases: [], ops: ["fs-calibration"] },
};

/** The measurement a finished child printed, or a failed entry: a spawn error, a nonzero exit, a signal or no JSON line is a failure. */
function childOutcome(request: ChildRequest, end: ChildEnd): Record<string, unknown> {
  if (end.error === undefined && end.code === 0 && end.signal === null && end.json !== null) return end.json;
  return { mode: request.mode, name: request.name, failed: true, code: end.code, signal: end.signal, error: end.error?.message, stderr: end.stderr.slice(-4000), stdout: end.stdout.slice(-2000) };
}

/**
 * The runtime of every measured child, whatever runs the driver (Bun as the test runner, or Node per the usage above):
 * the fs observer (`./fs-observer.ts`) tallies through `syncBuiltinESMExports`, which rebinds the named `node:fs` imports
 * the measured operations use under Node only (under Bun every tally stays 0). Resolved through the child's PATH.
 */
const MEASURED_CHILD_RUNTIME = "node";

/** Keep child temp files inside the measurement workdir unless the caller chose explicit temp roots. */
export function measuredChildEnvironment(
  root: string, env: Readonly<Record<string, string>>, parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const temp = path.join(path.dirname(root), "tmp");
  return {
    PATH: parent.PATH ?? "/usr/bin:/bin", HOME: path.dirname(root), ...MEASURE_ENV, ...env,
    TMPDIR: parent.TMPDIR || temp, TMP: parent.TMP || temp, TEMP: parent.TEMP || temp,
  };
}

/** Run one child to completion (all output drained) with only the offline provider environment, under {@link MEASURED_CHILD_RUNTIME}. */
async function runMeasuredChild(script: string, request: ChildRequest, env: Readonly<Record<string, string>>): Promise<Record<string, unknown>> {
  const childEnv = measuredChildEnvironment(request.root, env);
  await mkdir(path.join(path.dirname(request.root), "tmp"), { recursive: true });
  return childOutcome(request, await childEnd(startChild(script, [JSON.stringify(request)], childEnv, MEASURED_CHILD_RUNTIME)));
}

/** Which part of a measurement to run: the corpus build, the timed operations, or both. */
type Stage = "build" | "ops" | "all";

/** The source and directory identity of the corpus completed by a build stage. */
async function buildMarker(root: string, name: string, docs: number, variant: Variant, source: Record<string, unknown>): Promise<Record<string, unknown>> {
  const directory = await stat(root);
  return {
    version: 1, variant: name, docs, shape: variant.shape(docs), dimensions: MEASURE_VECTOR_DIMENSIONS,
    corpus: { path: await realpath(root), dev: directory.dev, ino: directory.ino },
    source: { head: source.head, uncommittedTreeSha256: source.uncommittedTreeSha256 },
  };
}

/** Refuse an ops stage unless the completed build belongs to this corpus and source. */
async function requireBuildMarker(file: string, expected: Record<string, unknown>): Promise<void> {
  let recorded: unknown;
  try { recorded = JSON.parse(await readFile(file, "utf8")); }
  catch (cause) { throw new Error(`build marker missing or unreadable: ${file}`, { cause }); }
  if (JSON.stringify(recorded) !== JSON.stringify(expected)) throw new Error(`build marker does not match corpus and source: ${file}`);
}

/** One variant at one size, with what its children need. */
interface Measured {
  readonly name: string;
  readonly docs: number;
  readonly variant: Variant;
  readonly root: string;
  readonly script: string;
  readonly record: (entry: Record<string, unknown>) => Promise<void>;
}

/** A child request for `measured`. */
function requestFor(measured: Measured, mode: ChildRequest["mode"], step: string, passes: number): ChildRequest {
  return { mode, name: step, root: measured.root, shape: measured.variant.shape(measured.docs), dimensions: MEASURE_VECTOR_DIMENSIONS, passes };
}

/** Run one child, record its result, and fail the driver after a failed child. */
async function measureChild(measured: Measured, request: ChildRequest): Promise<void> {
  const result = await runMeasuredChild(measured.script, request, measured.variant.env ?? {});
  let disk: Record<string, unknown> = {};
  let diskError: string | undefined;
  if (request.mode === "build") {
    try { disk = { disk: await diskBytes(measured.root) }; }
    catch (error) { diskError = error instanceof Error ? error.message : String(error); }
  }
  await measured.record({
    variant: measured.name, docs: measured.docs, shape: request.shape, ...result, ...disk,
    ...(diskError === undefined ? {} : { failed: true, diskError }),
  });
  if (result.failed === true) throw new Error(`measurement child failed: ${measured.name}/${measured.docs} ${request.mode}/${request.name}`);
  if (diskError !== undefined) throw new Error(`measurement disk evidence failed: ${measured.name}/${measured.docs} ${request.mode}/${request.name}: ${diskError}`);
}

/** Build the corpus phase by phase. */
async function buildCorpus(measured: Measured): Promise<void> {
  for (const phase of measured.variant.phases) {
    await measureChild(measured, requestFor(measured, "build", phase, 1));
  }
}

/** Run the variant's operations (a `phase:` entry is a build child, run once). */
async function runOperations(measured: Measured): Promise<void> {
  for (const op of measured.variant.ops) {
    const phase = op.startsWith(PHASE_PREFIX);
    await measureChild(measured, phase ? requestFor(measured, "build", op.slice(PHASE_PREFIX.length), 1) : requestFor(measured, "op", op, 2));
  }
}

/** Build one variant at one size and/or run its operations; every child result is appended through `record`. */
async function measureOne(script: string, base: string, target: { name: string; docs: number; stage: Stage }, source: Record<string, unknown>, record: (entry: Record<string, unknown>) => Promise<void>): Promise<void> {
  const variant = VARIANTS[target.name];
  if (variant === undefined) throw new Error(`unknown variant ${target.name}`);
  const measured: Measured = { name: target.name, docs: target.docs, variant, root: path.join(base, `${target.name}-${target.docs}`), script, record };
  const built = path.join(base, `${target.name}-${target.docs}.built.json`);
  if (target.stage !== "ops") {
    await rm(built, { force: true });
    await mkdir(measured.root, { recursive: true });
    await buildCorpus(measured);
    await writeFile(built, `${JSON.stringify(await buildMarker(measured.root, target.name, target.docs, variant, source))}\n`);
  }
  if (target.stage === "build") return;
  await requireBuildMarker(built, await buildMarker(measured.root, target.name, target.docs, variant, source));
  await runOperations(measured);
}

/** Run `plan` (variant:docs pairs) at `stage`, appending results to `out`; corpora live under `base`. */
export async function runMeasurements(out: string, plan: ReadonlyArray<readonly [string, number]>, base?: string, stage: Stage = "all"): Promise<Record<string, unknown>> {
  const source = environment();
  const script = await bundleChild("test/scale-measure/child.ts");
  const workdir = base ?? await mkdtemp(path.join(path.dirname(out), "llmwiki-scale-measure-"));
  const results: Record<string, unknown> = { environment: source, workdir, stage, dimensions: MEASURE_VECTOR_DIMENSIONS, entries: [] };
  const record = resultsRecorder(out, results);
  for (const [name, docs] of plan) await measureOne(script, workdir, { name, docs, stage }, source, record);
  return results;
}

if (import.meta.main) {
  const [out, spec, stage = "all", base] = process.argv.slice(2);
  if (out === undefined || spec === undefined || !["build", "ops", "all"].includes(stage)) {
    throw new Error("usage: node <bundle> <out.json> <variant>:<docs>[,...] [build|ops|all] [corpus-dir]");
  }
  const plan = spec.split(",").map((pair) => { const [name, docs] = pair.split(":"); return [name!, Number(docs)] as const; });
  await runMeasurements(path.resolve(out), plan, base === undefined ? undefined : path.resolve(base), stage as Stage);
}
