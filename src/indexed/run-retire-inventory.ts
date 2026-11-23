/**
 * @file src/indexed/run-retire-inventory.ts
 * @description The INVENTORY a batch run retirement (`./run-retire.ts`)
 * plans and, under the maintenance lock, recomputes: every run store, the
 * CLASS of each run, and anything that makes the inventory untrustworthy (a
 * BLOCKER: the retirement refuses).
 *
 * WHAT IS KEPT. Every run is kept unless it is a CANDIDATE, which is exactly:
 * - a `done` run that is not the compile state's last run (`lastRun`, whose
 *   start bounds restart inheritance, `../compiler/batch/inherit.ts`), or
 * - a `superseded` run that carries NO restart publication evidence at all
 *   (no raw `pi:` key of any attempt, no visible `ih:` row), so no later
 *   restart could inherit anything from it, whatever its timestamps;
 * and is not named by any pin (a pin protects its whole store, an empty
 * manifest too), is not among the newest `keepFinished` such runs (report
 * retention, never deletion authority), has a canonical ISO-8601 start (so that
 * ordering is defined), and holds only its manifest and segment-named regular
 * single-link files. A superseded run WITH evidence is kept (conservatively:
 * no timestamp or subset reasoning retires it).
 *
 * BUDGET. One plan retires at most {@link MAX_PLAN_LEAVES} leaves in total
 * (each store at most `MAX_RETIRE_LEAVES`, so each receipt stays bounded); the
 * candidates are taken OLDEST first and the eligible runs beyond the budget are
 * `deferred` (deterministically), and the preview says so: retire again.
 *
 * BLOCKERS: a live or unreadable retirement barrier, a restore marker, an
 * unlistable or unexpected `.llmwiki/indexed` entry (the shared indexed
 * inventory cap), a store named like a run store that is not one (run
 * discovery would refuse it too), a pin blocker, unowned or mismatched quarantine
 * entries, any run store whose manifest is absent or malformed, a compile
 * state that cannot be read while run stores exist, any run that cannot be
 * read, and any ACTIVE run (it may not have inherited yet).
 *
 * READS. Manifests are read as leaves, without a lease. Only the evidence of a
 * superseded run and the compile state open snapshots: under a lease in a
 * preview, lease-free inside the apply's locked scope, which this module never
 * leaves (it returns plain, validated metadata).
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { isRunStoreName, RUN_STORE_PREFIX, type BatchPhase } from "../compiler/batch/contracts.js";
import { BatchRun, manifestDigest, unleasedRunMeta, type RunMetaV1 } from "../compiler/batch/run-store.js";
import { compileStateMetaOf } from "../cstate/contracts.js";
import { openCompileState } from "../cstate/store.js";
import { INDEXED_DIR } from "../segments/contracts.js";
import { sha256Hex } from "../segments/format.js";
import { readManifestLeaf } from "../segments/io.js";
import { readRestoreMarker } from "../segments/restore-marker.js";
import { retireFenceState } from "../segments/retire-barrier.js";
import { listStores, storeDirectory } from "./gc-inventory.js";
import { readPins } from "./pins.js";
import { quarantineInventory, RETIRING_DIR, storeLeaves, type PendingCleanupV1, type RunEligibilityV1 } from "./run-retire-quarantine.js";

/** Why a run is kept, or `candidate`. `deferred`: eligible, but beyond this plan's leaf budget. */
export type RunClassV1 = "active" | "last-run" | "pinned" | "unproven-superseded" | "unremovable" | "report-retained" | "deferred" | "candidate";

/** Most leaves one plan retires in total (its receipts' aggregate stays bounded too). */
const MAX_PLAN_LEAVES = 200_000;

/** One run as the inventory sees it. */
export interface RunEntryV1 {
  readonly runId: string;
  readonly phase: BatchPhase;
  readonly startedAt: string;
  readonly checkpoint: number;
  /** Report lines its store holds (lost when it is retired). */
  readonly reported: number;
  readonly class: RunClassV1;
  readonly reason: string;
}

/** A run that may be retired, bound by its manifest and exact leaf set. */
export interface RunCandidateV1 {
  readonly store: string;
  readonly runId: string;
  readonly eligibility: RunEligibilityV1;
  readonly manifestSha256: string;
  readonly leafDigest: string;
  readonly leaves: number;
  readonly bytes: number;
}

/** The whole inventory: plain, validated metadata only. */
export interface RunInventoryV1 {
  readonly rootDigest: string;
  readonly cstateManifestSha256: string | null;
  readonly lastRun: string | null;
  readonly pinsDigest: string;
  /** Binds every run store's name and manifest digest. */
  readonly runSetDigest: string;
  readonly runs: readonly RunEntryV1[];
  readonly candidates: readonly RunCandidateV1[];
  readonly pendingCleanup: readonly PendingCleanupV1[];
  /** A barrier whose owner is gone: the apply removes it first. */
  readonly staleBarrier: boolean;
  /** Whether eligible runs were deferred by the plan's leaf budget. */
  readonly truncated: boolean;
  readonly blockers: readonly string[];
}

/** One run store read lease-free: its manifest digest and strict meta. */
interface RunRead { readonly store: string; readonly manifestSha256: string; readonly meta: RunMetaV1 }

/** The compile state's binding of its last run. */
interface LastRunBinding { readonly lastRun: string | null; readonly cstateManifestSha256: string | null }

/** An error's message. */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A SHA-256 of `text`. */
const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Whether `value` is a canonical ISO-8601 instant (exactly what `Date#toISOString` writes). */
function canonicalInstant(value: string): boolean {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

/** Read one run store's manifest leaf and strict meta, or a blocker. */
async function readRun(root: string, store: string): Promise<RunRead | string> {
  try {
    const leaf = await readManifestLeaf(root, store);
    if (leaf.kind !== "ok") return `run store ${store} has no manifest (a lost manifest is evidence, never garbage); inspect it by hand`;
    return { store, manifestSha256: sha256Hex(leaf.bytes), meta: await unleasedRunMeta(root, store.slice(RUN_STORE_PREFIX.length)) };
  } catch (error) {
    return `run store ${store} cannot be read: ${messageOf(error)}`;
  }
}

/** The compile state's last run and manifest digest, or a blocker. */
async function lastRunOf(root: string): Promise<LastRunBinding | string> {
  try {
    const store = await openCompileState(root);
    return { lastRun: compileStateMetaOf(store).lastRun, cstateManifestSha256: manifestDigest(store) };
  } catch (error) {
    return `the compile state cannot be read, so its last run cannot be protected: ${messageOf(error)}`;
  }
}

/** Whether superseded run `runId` carries no restart publication evidence at all. */
async function evidenceFree(root: string, runId: string): Promise<boolean> {
  const run = await BatchRun.open(root, runId);
  for await (const _key of run.keysEverWritten("pi:")) return false;
  for await (const _row of run.scan("ih:")) return false;
  return true;
}

/** The class that keeps a run regardless of retention, or how it would be eligible. */
async function keptOrEligible(root: string, read: RunRead, lastRun: string | null, pinned: ReadonlyMap<string, unknown>): Promise<readonly [RunClassV1, string] | RunEligibilityV1> {
  const { meta, store } = read;
  if (meta.phase !== "done" && meta.phase !== "superseded") return ["active", "the run is active; finish it (llmwiki compile) or supersede it (llmwiki compile --restart) first"];
  if (meta.runId === lastRun) return ["last-run", "the compile state's last run (its start bounds restart inheritance)"];
  if (pinned.has(store)) return ["pinned", "a pin names this store"];
  if (meta.phase === "superseded" && !(await evidenceFree(root, meta.runId))) return ["unproven-superseded", "superseded with restart publication evidence (pi: or ih: keys) a later restart may need"];
  if (!canonicalInstant(meta.startedAt)) return ["unremovable", "its start time is not a canonical ISO-8601 instant, so report retention cannot order it"];
  return meta.phase === "superseded" ? "superseded-without-evidence" : "done-not-last-run";
}

/** The entry of `read` in `cls` for `reason`. */
function entryOf(read: RunRead, cls: RunClassV1, reason: string): RunEntryV1 {
  const { runId, phase, startedAt, checkpoint, counters } = read.meta;
  return { runId, phase, startedAt, checkpoint, reported: counters.reported, class: cls, reason };
}

/** The candidate of an eligible run, or the entry that keeps it when its leaves are not exactly ours. */
async function candidateOf(root: string, read: RunRead, eligibility: RunEligibilityV1): Promise<RunCandidateV1 | RunEntryV1> {
  const leaves = await storeLeaves(root, path.posix.join(INDEXED_DIR, read.store), await storeDirectory(root, read.store));
  if (typeof leaves === "string") return entryOf(read, "unremovable", leaves);
  return { store: read.store, runId: read.meta.runId, eligibility, manifestSha256: read.manifestSha256, leafDigest: leaves.digest, leaves: leaves.identities.length, bytes: leaves.bytes };
}

/** Classify every run: kept classes, then report retention over the newest eligible runs, then the leaf check. */
async function classifyRuns(root: string, reads: readonly RunRead[], lastRun: string | null, pinned: ReadonlyMap<string, unknown>, keepFinished: number) {
  const runs: RunEntryV1[] = [];
  const eligible: { read: RunRead; eligibility: RunEligibilityV1 }[] = [];
  for (const read of reads) {
    const verdict = await keptOrEligible(root, read, lastRun, pinned);
    if (typeof verdict === "string") eligible.push({ read, eligibility: verdict }); else runs.push(entryOf(read, verdict[0], verdict[1]));
  }
  // Newest first; the run id breaks a tie deterministically.
  eligible.sort((a, b) => (a.read.meta.startedAt === b.read.meta.startedAt ? (a.read.meta.runId < b.read.meta.runId ? 1 : -1) : a.read.meta.startedAt < b.read.meta.startedAt ? 1 : -1));
  const candidates: RunCandidateV1[] = [];
  let leaves = 0;
  for (const { read } of eligible.slice(0, keepFinished)) runs.push(entryOf(read, "report-retained", `among the newest ${keepFinished} finished runs kept for their reports`));
  // Oldest first, so a leaf budget defers the newest of the rest.
  for (const { read, eligibility } of eligible.slice(keepFinished).reverse()) {
    const found = await candidateOf(root, read, eligibility);
    if (!("eligibility" in found)) { runs.push(found); continue; }
    if (leaves + found.leaves > MAX_PLAN_LEAVES) { runs.push(entryOf(read, "deferred", `beyond this plan's ${MAX_PLAN_LEAVES}-leaf budget; retire again afterwards`)); continue; }
    leaves += found.leaves;
    candidates.push(found);
    runs.push(entryOf(read, "candidate", eligibility));
  }
  return { runs: runs.sort((a, b) => (a.runId < b.runId ? -1 : 1)), candidates: candidates.sort((a, b) => (a.store < b.store ? -1 : 1)) };
}

/** The barrier (an interrupted publication included) and restore-marker blockers that stop the inventory before it reads any store. */
async function fenceBlockers(root: string): Promise<{ blockers: string[]; staleBarrier: boolean }> {
  const barrier = await retireFenceState(root);
  const blockers = barrier.kind === "blocking" ? [barrier.reason] : [];
  if ((await readRestoreMarker(root)).kind !== "absent") blockers.push("an indexed-authority restore marker is present; finish that restore first");
  return { blockers, staleBarrier: barrier.kind === "stale" };
}

/** Read every run store (lease-free leaves), each as its read or a blocker. */
async function readRuns(root: string, stores: readonly string[]): Promise<(RunRead | string)[]> {
  const reads: (RunRead | string)[] = [];
  for (const store of stores) reads.push(await readRun(root, store));
  return reads;
}

/** Inventory every run of the project at canonical `root` (see the file comment). */
export async function inventoryRuns(root: string, keepFinished: number): Promise<RunInventoryV1> {
  const fence = await fenceBlockers(root);
  const empty = { rootDigest: digestOf(root), cstateManifestSha256: null, lastRun: null, pinsDigest: "", runSetDigest: "", runs: [], candidates: [], pendingCleanup: [], staleBarrier: fence.staleBarrier, truncated: false };
  if (fence.blockers.length > 0) return { ...empty, blockers: fence.blockers };
  const listed = await listStores(root);
  const pins = await readPins(root, new Set(listed.stores));
  const quarantine = await quarantineInventory(root).catch((error: unknown) => ({ pending: [], blockers: [`${RETIRING_DIR} cannot be inspected: ${messageOf(error)}`] }));
  const runStores = listed.stores.filter(isRunStoreName);
  const misnamed = listed.stores.filter((store) => store.startsWith(RUN_STORE_PREFIX) && !isRunStoreName(store)).map((store) => `store ${store} is named like a batch run store but is not one (run discovery refuses it too); inspect it by hand`);
  const reads = await readRuns(root, runStores);
  const binding = runStores.length === 0 ? { lastRun: null, cstateManifestSha256: null } : await lastRunOf(root);
  const blockers = [...listed.blockers, ...misnamed, ...pins.blockers, ...quarantine.blockers, ...reads.filter((read): read is string => typeof read === "string"), ...(typeof binding === "string" ? [binding] : [])];
  if (blockers.length > 0 || typeof binding === "string") return { ...empty, blockers };
  const ok = reads as RunRead[];
  let classified: Awaited<ReturnType<typeof classifyRuns>>;
  // A run whose evidence or leaves cannot be read makes the whole inventory uncertain: refuse rather than guess.
  try { classified = await classifyRuns(root, ok, binding.lastRun, pins.protectedBy, keepFinished); } catch (error) { return { ...empty, blockers: [`a run store cannot be classified: ${messageOf(error)}`] }; }
  const active = classified.runs.filter((run) => run.class === "active").map((run) => `batch compile run ${run.runId} is active; finish it (llmwiki compile) or supersede it (llmwiki compile --restart) first`);
  return {
    ...empty, ...binding, pinsDigest: pins.digest, runSetDigest: digestOf(JSON.stringify(ok.map((read) => [read.store, read.manifestSha256]))),
    runs: classified.runs, candidates: active.length > 0 ? [] : classified.candidates, pendingCleanup: quarantine.pending, blockers: active,
    truncated: classified.runs.some((run) => run.class === "deferred"),
  };
}
