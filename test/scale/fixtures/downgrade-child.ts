/**
 * @file test/scale/fixtures/downgrade-child.ts
 * @description A child process for the scale-down tests, so every process
 * that opens a fixture's indexed stores (a build, a preview reading them
 * under a reader lease, an apply that must be a fresh collector, a snapshot)
 * is a REAL separate process. Vitest-free.
 *
 * Modes (arguments after the script):
 * - `build <root>`: a corpus, a sample `state.json`, events, relations, a
 *   workspace operation catalog and a JSON embedding store, prepared
 *   `local-indexed` WITH `segmented-compile-state-1` through the real
 *   set-and-prepare bodies; then one more event, relation and catalog record
 *   written AFTER activation (so every frozen backup is stale).
 * - `build-late <root>`: the same, but with NO history or embeddings before
 *   activation (only after it), so no incumbent graph file or directory exists.
 * - `large <root>`: a corpus prepared `local-large` (the binary container).
 * - `preview <root> <target> <documents> <planFile>`: the scale-down preview;
 *   writes the plan text to `planFile`, returns readiness, blockers, notices.
 * - `apply <root> <planFile> [crash <seam>]`: apply the plan (readers asserted
 *   offline, ample space); with `crash`, the process EXITS at that seam, as
 *   a killed process would after that durable checkpoint.
 * - `apply-unasserted <root> <planFile>`: apply without the readers assertion.
 * - `cancel <root> <planFile> [mutate authority|outside]`: the pre-install
 *   cancel of the plan; with `mutate`, at the `cancel:after-intent` seam (after
 *   the durable cancel intent, before the record step) it changes an
 *   AUTHORITY file (the catalog store's manifest bytes) or a file OUTSIDE the
 *   export and authority targets (a source).
 * - `snapshot <root>`: the logical content through the ordinary routed reads:
 *   events, relation records, the workspace catalog, the compile state, the
 *   embedding store (as loaded for search), and the scale status.
 * - `append <root>`: one more event through the ordinary path.
 * - `run <root>`: a finished batch run store with one report line (a scratch
 *   run: no real compile binds it); prints its id.
 * - `report <root> <runId>`: `compile --report`'s reader on the live layout.
 * - `archives <root>`; `archive-report <root> <name> <runId> [cursor]`: the archive reader.
 * - `reupgrade <root>`: an ordinary `scale set` back to an indexed estimate.
 * - `apply-fail-retry <root> <planFile>`: in ONE process, an apply whose seam
 *   throws after staging (a controlled failure), then the same apply again.
 * - `sdk-preview <root> <planFile>`; `sdk-apply <root> <planFile>`: the same
 *   through the SDK facade (`wiki.scale.preview`, `wiki.scale.downgrade`).
 * Each mode prints one JSON line: the outcome, or the error code.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "../../../src/events/store.js";
import { readEvents } from "../../../src/events/store-read.js";
import { appendCatalogRecordLocked, createCatalogRecord, readCatalogStore } from "../../../src/operation-bundles/catalog-store.js";
import type { MutationId } from "../../../src/operation-bundles/ids.js";
import type { EntityId, ProfilePack } from "../../../src/profile/types.js";
import { appendRelation } from "../../../src/relations/store.js";
import { readRelationRecords } from "../../../src/relations/store-read.js";
import { report, readReport } from "../../../src/compiler/batch/report.js";
import { BatchRun } from "../../../src/compiler/batch/run-store.js";
import { applyScaleDowngrade } from "../../../src/scale/downgrade-apply.js";
import { cancelScaleDowngrade } from "../../../src/scale/downgrade-cancel.js";
import { listScaleArchives, readArchivedReport } from "../../../src/scale/downgrade-archive-reader.js";
import type { DowngradeSeam } from "../../../src/scale/downgrade-contracts.js";
import { parseDowngradePlan, serializeDowngradePlan } from "../../../src/scale/downgrade-plan.js";
import { previewScaleDowngrade } from "../../../src/scale/preview.js";
import { canonicalRoot } from "../../../src/segments/reader-lease.js";
import { diskScaleTransitionSteps, scaleStatus, setExpectedScaleWith } from "../../../src/scale/transition.js";
import { readStoredEmbeddings } from "../../../src/utils/embeddings-storage.js";
import { asPageVectorRow, decodeVector } from "../../../src/vectors/codec.js";
import { openVectorStore, readyVectorMeta } from "../../../src/vectors/store.js";
import { createWikiCore } from "../../../src/sdk/core.js";
import { readState, writeState } from "../../../src/utils/state.js";
import { writeCorpus } from "../../catalog/helpers.js";
import { sampleState } from "../../cstate/sample-state.js";
import { runChildModes } from "../../indexed/fixtures/child-main.js";
import { vectorsFromStoredRead } from "./downgrade-vectors.js";

const EVENT = { type: "connector-fetch" as const, origin: "fixture", payload: {}, at: "2026-10-30T00:00:00.000Z" };
const WORKSPACE = "research";
const PROFILE: ProfilePack = { schemaVersion: 1, profileId: "research", entities: { experiments: { directory: "wiki/experiments" }, ideas: { directory: "wiki/ideas" } }, relations: { tests: { from: ["experiments"], to: ["ideas"], direction: "directed" } } };
const AMPLE = { freeBytes: async () => Number.MAX_SAFE_INTEGER };

/** One catalog record for `seed`. */
function catalogRecord(seed: string) {
  const mutationId = `opm_${createHash("sha256").update(seed).digest("hex")}` as MutationId;
  return createCatalogRecord({ logicalRecordId: `logical-${seed}`, mutationId, payload: { seed }, createdAt: "2026-10-30T00:00:00.000Z" });
}

/** One relation to idea `n`. */
const relation = (n: number) => ({ type: "tests", from: "experiments/a" as EntityId, to: `ideas/n${n}` as EntityId, attributes: {} });

/** A valid v3 JSON embedding store of two 8-dimensional page vectors (exact in float32). */
async function writeEmbeddings(root: string): Promise<void> {
  /** The exact float32 vector of `seed`. */
  const vector = (seed: number) => Array.from({ length: 8 }, (_, at) => ((seed * 13 + at * 7) % 64 - 32) / 64);
  /** The page entry of `slug`. */
  const entry = (slug: string, seed: number) => ({ pageId: `concepts/${slug}`, title: slug, summary: `About ${slug}`, embeddingTextHash: "a".repeat(64), vector: vector(seed), updatedAt: "2026-10-30T00:00:00.000Z" });
  const store = { version: 3, model: "offline-embed", dimensions: 8, entries: [entry("page-0", 1), entry("page-1", 2)], chunks: [] };
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(root, ".llmwiki", "embeddings.json"), JSON.stringify(store));
}

/** Write one event, relation and catalog record (`suffix` keeps them distinct). */
async function writeHistory(root: string, suffix: string, count: number): Promise<void> {
  for (let n = 0; n < count; n += 1) {
    await appendEvent(root, { ...EVENT, origin: `${suffix}-${n}` });
    await appendRelation(root, PROFILE, relation(suffix === "before" ? n : 100 + n));
    await appendCatalogRecordLocked(root, WORKSPACE, catalogRecord(`${suffix}-${n}`));
  }
}

/** Build the indexed fixture; `late` writes no history before activation (so no incumbent graph files or directory exist). */
async function build([root]: string[], late = false): Promise<unknown> {
  await writeCorpus(root!, 4, 3);
  await writeState(root!, sampleState());
  if (!late) {
    await writeHistory(root!, "before", 2);
    await writeEmbeddings(root!);
  }
  const steps = { ...diskScaleTransitionSteps(root!), preflight: AMPLE };
  const report = await setExpectedScaleWith(steps, { request: { documents: 8_000 }, capabilities: ["segmented-compile-state-1"] });
  if (report.readiness !== "ready") throw new Error(`the fixture did not prepare: ${report.readiness}`);
  await writeHistory(root!, "after", 1);
  return { readiness: report.readiness };
}

/** Build a `local-large` fixture. */
async function large([root]: string[]): Promise<unknown> {
  await writeCorpus(root!, 4, 3);
  await writeEmbeddings(root!);
  const report = await setExpectedScaleWith({ ...diskScaleTransitionSteps(root!), preflight: AMPLE }, { request: { documents: 2_000 } });
  return { readiness: report.readiness, active: report.record?.active.architecture };
}

/** Preview a scale-down and save its plan. */
async function preview([root, target, documents, planFile]: string[]): Promise<unknown> {
  const result = await previewScaleDowngrade(root!, { target: target as "local-standard" | "local-large", request: { documents: Number(documents) } }, AMPLE);
  await writeFile(planFile!, serializeDowngradePlan(result.plan));
  return { ready: result.ready, blockers: result.plan.inventory.blockers, notices: result.plan.inventory.notices, units: result.plan.inventory.units, digest: result.plan.digest };
}

/** Apply a saved plan, optionally exiting at one seam. */
async function apply([root, planFile, mode, seam]: string[], readersOffline = true): Promise<unknown> {
  const plan = parseDowngradePlan(await readFile(planFile!, "utf8"), await canonicalRoot(root!));
  const crash = mode === "crash" ? async (stage: DowngradeSeam) => { if (stage === seam) process.exit(70); } : undefined;
  return applyScaleDowngrade(root!, plan, { readersOffline, space: AMPLE, ...(crash === undefined ? {} : { seam: crash }) });
}

/** The edit of a `mutate` cancel: an authority file (the catalog manifest's bytes), or a source outside every target. */
async function mutateAt(root: string, what: string): Promise<void> {
  if (what === "authority") await appendFile(path.join(root, ".llmwiki", "indexed", "catalog", "manifest.json"), " ");
  else await appendFile(path.join(root, "sources", "src-00000.md"), "\nAn edit outside the export targets.\n");
}

/** Cancel a saved plan, optionally changing a file at the `cancel:after-intent` seam. */
async function cancel([root, planFile, mode, what]: string[]): Promise<unknown> {
  const plan = parseDowngradePlan(await readFile(planFile!, "utf8"), await canonicalRoot(root!));
  const seam = mode === "mutate" ? async (stage: DowngradeSeam) => { if (stage === "cancel:after-intent") await mutateAt(root!, what!); } : undefined;
  return cancelScaleDowngrade(root!, plan, { readersOffline: true, ...(seam === undefined ? {} : { seam }) });
}

/** Every page vector of an indexed `root` by page id, from its rows. */
async function indexedVectors(root: string): Promise<Record<string, number[]>> {
  const vectors: Record<string, number[]> = {};
  const store = await openVectorStore(root);
  const { dimensions } = readyVectorMeta(store);
  for await (const row of store.scan({ prefix: "p:" })) vectors[row.k.slice(2)] = Array.from(decodeVector(asPageVectorRow(row.v, row.k).vec, dimensions));
  return vectors;
}

/** Every page vector of `root` by page id: the indexed rows, or the incumbent store's entries. */
async function pageVectors(root: string, indexed: boolean, required: boolean): Promise<Record<string, number[]>> {
  if (indexed) return indexedVectors(root);
  return vectorsFromStoredRead(await readStoredEmbeddings(root), required);
}

/** The logical content of `root` through the ordinary routed reads. */
async function snapshot([root]: string[]): Promise<unknown> {
  const status = await scaleStatus(root!);
  const indexed = status.record?.active.architecture === "local-indexed";
  return {
    events: (await readEvents(root!)).events, relations: await readRelationRecords(root!), catalog: await readCatalogStore(root!, WORKSPACE),
    state: await readState(root!), vectors: await pageVectors(root!, indexed, status.record?.active.architecture === "local-large"), active: status.record?.active.architecture, readiness: status.readiness, version: status.record?.version,
  };
}

/** A finished scratch batch run with one report line. */
async function finishedRun([root]: string[]): Promise<unknown> {
  const run = await BatchRun.create(root!, { batchSize: 10, embeddings: false, identity: { policy: "p", sources: null, cstate: "c" } });
  await report(run, { kind: "compiled", file: "sources/src-00000.md" });
  await run.advance("done");
  return { runId: run.runId };
}

/** A controlled failure after staging, then the same apply again, in this one process. */
async function failThenRetry([root, planFile]: string[]): Promise<unknown> {
  const plan = parseDowngradePlan(await readFile(planFile!, "utf8"), await canonicalRoot(root!));
  /** A seam that fails once staging is complete. */
  const failing = async (stage: DowngradeSeam) => { if (stage === "after-stage") throw new Error("injected failure after staging"); };
  const first = await applyScaleDowngrade(root!, plan, { readersOffline: true, space: AMPLE, seam: failing }).then(() => "applied", (error: { code?: string }) => error.code ?? String(error));
  const second = await applyScaleDowngrade(root!, plan, { readersOffline: true, space: AMPLE });
  return { first, second };
}

/** The SDK's transition preview and scale-down preview; the plan saved for a later process. */
async function sdkPreview([root, planFile]: string[]): Promise<unknown> {
  const wiki = createWikiCore({ root: root! });
  const transition = await wiki.scale.preview({ documents: 100 });
  const downgrade = await wiki.scale.downgrade.preview({ target: "local-standard", documents: 100 });
  await writeFile(planFile!, serializeDowngradePlan(downgrade.plan));
  return { change: transition.change, ready: downgrade.ready };
}

/** The SDK's apply of a saved plan (text), in a fresh process. */
async function sdkApply([root, planFile]: string[]): Promise<unknown> {
  const wiki = createWikiCore({ root: root! });
  const result = await wiki.scale.downgrade.apply(await readFile(planFile!, "utf8"), { readersOffline: true });
  return { target: result.target, archives: (await wiki.scale.archives.list()).length };
}

await runChildModes({
  build, large, preview, apply, cancel, snapshot,
  "build-late": (args) => build(args, true),
  "apply-unasserted": (args) => apply(args, false),
  append: async ([root]) => (await appendEvent(root!, { ...EVENT, origin: "post-downgrade" })).id,
  run: finishedRun,
  report: async ([root, runId]) => readReport(root!, runId!),
  archives: async ([root]) => listScaleArchives(root!),
  "archive-report": async ([root, name, runId, cursor]) => readArchivedReport(root!, name!, runId!, cursor),
  reupgrade: async ([root]) => (await setExpectedScaleWith({ ...diskScaleTransitionSteps(root!), preflight: AMPLE }, { request: { documents: 8_000 } })).record?.active.architecture,
  "apply-fail-retry": failThenRetry,
  "sdk-preview": sdkPreview,
  "sdk-apply": sdkApply,
});
