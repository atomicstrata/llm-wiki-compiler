/**
 * @file src/compiler/batch/run-store.ts
 * @description The RUN STORE of a batch compile (`./contracts.ts`): one
 * segment store `crun-<runId>` per run, written through a bounded buffer.
 *
 * WRITES. Rows are buffered (`put`, `del`; each physical row within the
 * segment row cap) and published with the meta in one conditional commit per
 * CHECKPOINT, which completes the units of work buffered since the last one
 * and moves the committed phase, cursor and counters together. A buffer past
 * its bound is published early WITHOUT a checkpoint. Every row is versioned
 * (`./run-versions.ts`): an early-published version stays invisible to every
 * later attempt unless its attempt checkpointed it, so a crash and resume
 * redoes the unfinished unit from the committed cursor over exactly the
 * committed rows. Each checkpoint's meta is a deep SNAPSHOT taken when it is
 * published (an early publication re-publishes that snapshot), so a cursor
 * object its caller goes on mutating cannot advance the committed position. Point reads see the buffer first; a scan merges a snapshot
 * of the buffered rows into the stored ones and yields the visible values.
 *
 * ATTEMPTS. Opening a run to continue it starts a new attempt, recorded in
 * the meta before anything else is written.
 *
 * ONE ACTIVE RUN. A run is active until it is `done` or `superseded`; a new
 * run refuses while another is active (`compile_batch_run_active`) unless it
 * supersedes it explicitly (`restart`).
 */

import { randomBytes } from "node:crypto";
import { hasExactKeys, isCount } from "../../history/contracts.js";
import { INDEXED_DIR, MAX_INDEXED_STORE_ENTRIES, MAX_KEY_CHARS, MAX_ROW_BYTES, sortedByKey, type SegmentRow } from "../../segments/contracts.js";
import { sha256Hex } from "../../segments/format.js";
import { diskSegmentStoreIo, readManifestLeaf, type SegmentStoreIo } from "../../segments/io.js";
import { parseManifest, serializeManifest } from "../../segments/manifest.js";
import { SegmentStore } from "../../segments/store.js";
import { listConfinedDirBounded } from "../../utils/confined-dir.js";
import { BATCH_PHASES, BatchCompileError, MAX_BATCH_SIZE, RUN_STORE_PREFIX, zeroCounters, type BatchCountersV1, type BatchPhase } from "./contracts.js";
import { isPhaseCursor } from "./cursor.js";
import { Visibility, type AttemptStart, type RowVersion, type VersionedRow } from "./run-versions.js";

/** Most buffered rows before an early publication. */
const MAX_PENDING_ROWS = 4_096;
/** Most buffered row bytes before an early publication. */
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
/** Most attempts one run records before it refuses to resume again. */
const MAX_ATTEMPTS = 10_000;

/** What identifies a run's inputs: a resume must find them unchanged. */
export interface RunIdentityV1 {
  /** The policy digest: prompt modifiers, schema, profile, provider and model, extraction contract. */
  readonly policy: string;
  /** The source-set digest computed by the listing; `null` until then. */
  readonly sources: string | null;
  /** The compile-state manifest digest the run started from (or last published itself). */
  readonly cstate: string;
}

/** The run store's meta. */
export interface RunMetaV1 {
  readonly schema: 1;
  readonly runId: string;
  readonly phase: BatchPhase;
  /** The phase's resume position (phase-specific JSON). */
  readonly cursor: Readonly<Record<string, unknown>>;
  readonly batchSize: number;
  /** Always `false` today: a batch compile refreshes no embeddings (the driver refuses one that would). */
  readonly embeddings: boolean;
  readonly identity: RunIdentityV1;
  readonly counters: BatchCountersV1;
  readonly startedAt: string;
  /** Checkpoints published so far. */
  readonly checkpoint: number;
  /** When each attempt began. */
  readonly attempts: readonly AttemptStart[];
}

/** The digest of a store's current manifest. */
export function manifestDigest(store: SegmentStore): string {
  return sha256Hex(serializeManifest(store.manifest));
}

/** Whether `value` is a set of counters (every known counter a non-negative integer, no other key). */
function isCounters(value: unknown): value is BatchCountersV1 {
  const keys = Object.keys(zeroCounters());
  return hasExactKeys(value, keys) && keys.every((key) => isCount(value[key]));
}

/** Whether `value` is a run identity. */
function isIdentity(value: unknown): value is RunIdentityV1 {
  return hasExactKeys(value, ["policy", "sources", "cstate"]) && typeof value.policy === "string" && (value.sources === null || typeof value.sources === "string") && typeof value.cstate === "string";
}

/** Whether `value` is an ascending list of attempt starts. */
function isAttempts(value: unknown, checkpoint: number): value is AttemptStart[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ATTEMPTS) return false;
  return value.every((start, at) => hasExactKeys(start, ["a", "from"]) && start.a === at && isCount(start.from) && start.from <= checkpoint && (at === 0 || start.from >= value[at - 1].from));
}

/** Whether `value` names a phase a run can be in. */
const isPhase = (value: unknown): value is BatchPhase => (BATCH_PHASES as readonly unknown[]).includes(value) || value === "superseded";
/** Whether the meta's batch size and embeddings switch are valid. */
const validSizes = (value: Record<string, unknown>): boolean => isCount(value.batchSize) && value.batchSize >= 1 && value.batchSize <= MAX_BATCH_SIZE && typeof value.embeddings === "boolean";

/** The closed meta's exact keys. */
const RUN_META_KEYS = ["schema", "runId", "phase", "cursor", "batchSize", "embeddings", "identity", "counters", "startedAt", "checkpoint", "attempts"];

/** Whether `value` has the closed meta's keys, schema, run id and checkpoint count. */
const isRunHeader = (value: unknown, runId: string): value is Record<string, unknown> => hasExactKeys(value, RUN_META_KEYS) && value.schema === 1 && value.runId === runId && isCount(value.checkpoint);

/** Whether the meta's phase and cursor are a position that phase writes. */
const isPosition = (value: Record<string, unknown>): boolean => isPhase(value.phase) && isPhaseCursor(value.phase, value.cursor);

/** Whether `value` is the closed meta of run `runId`. */
function isRunMeta(value: unknown, runId: string): value is RunMetaV1 {
  if (!isRunHeader(value, runId)) return false;
  return isPosition(value) && validSizes(value) && isIdentity(value.identity) && isCounters(value.counters) && typeof value.startedAt === "string" && isAttempts(value.attempts, value.checkpoint as number);
}

/** Refuse unless `runId` is a run id. */
function assertRunId(runId: string): void {
  if (!/^[0-9a-f]{12}$/.test(runId)) throw new BatchCompileError("compile_batch_run_unknown", `${runId.slice(0, 40)} is not a run id`);
}

/** The meta of run `runId` from its published manifest's `meta` (`null`: never published); a malformed one is unknown, never a finished run. */
function checkedRunMeta(runId: string, meta: unknown | null): RunMetaV1 {
  if (meta === null) throw new BatchCompileError("compile_batch_run_unknown", `no batch compile run ${runId}`);
  if (!isRunMeta(meta, runId)) throw new BatchCompileError("compile_batch_run_unknown", `batch compile run ${runId} has a malformed manifest; inspect .llmwiki/indexed/${RUN_STORE_PREFIX}${runId} by hand`);
  return meta;
}

/** The store of run `runId` of the project at `root` (through `io` when given: a read-only archived store). */
function openRunStore(root: string, runId: string, io?: SegmentStoreIo): Promise<SegmentStore> {
  return SegmentStore.open(io ?? diskSegmentStoreIo(root, `${RUN_STORE_PREFIX}${runId}`));
}

/** A run store with its write buffer (see the file comment). */
export class BatchRun {
  private readonly pending = new Map<string, VersionedRow>();
  private pendingBytes = 0;
  private live: BatchCountersV1;
  private visibility: Visibility;

  private constructor(private store: SegmentStore, private committed: RunMetaV1, readonly root: string, private readonly attempt: number) {
    this.live = { ...committed.counters };
    this.visibility = new Visibility(committed.checkpoint, committed.attempts, attempt);
  }

  /** Open run `runId` READ-ONLY (it writes nothing); a malformed meta is unknown, never a finished run. */
  static async open(root: string, runId: string, io?: SegmentStoreIo): Promise<BatchRun> {
    assertRunId(runId);
    const store = await openRunStore(root, runId, io);
    return new BatchRun(store, checkedRunMeta(runId, store.exists ? store.meta : null), root, -1);
  }

  /** Continue run `runId`: a new attempt, recorded before anything else is written. */
  static async resume(root: string, runId: string): Promise<BatchRun> {
    const read = await BatchRun.open(root, runId);
    const meta: RunMetaV1 = { ...read.committed, attempts: [...read.committed.attempts, { a: read.committed.attempts.length, from: read.committed.checkpoint }] };
    if (meta.attempts.length > MAX_ATTEMPTS) throw new BatchCompileError("compile_batch_run_active", `batch compile run ${runId} was resumed ${MAX_ATTEMPTS} times; restart it`);
    const store = await read.store.commit({ meta: { ...meta } });
    return new BatchRun(store, meta, root, meta.attempts.length - 1);
  }

  /** Create a new run of the project at `root` (its first commit publishes its meta). */
  static async create(root: string, init: Pick<RunMetaV1, "batchSize" | "embeddings" | "identity">): Promise<BatchRun> {
    const runId = randomBytes(6).toString("hex");
    const meta: RunMetaV1 = {
      schema: 1, runId, phase: "listing", cursor: {}, counters: zeroCounters(), startedAt: new Date().toISOString(), checkpoint: 0, attempts: [{ a: 0, from: 0 }], ...init,
    };
    const store = await (await openRunStore(root, runId)).commit({ meta: { ...meta } });
    return new BatchRun(store, meta, root, 0);
  }

  /** The run's id. */
  get runId(): string { return this.committed.runId; }
  /** The run's meta as last checkpointed. */
  get meta(): RunMetaV1 { return this.committed; }
  /** The run's live counters (published with the next checkpoint). */
  get counters(): BatchCountersV1 { return this.live; }

  /** The physical row of `key`: the buffer first, then the store. */
  private async physical(key: string): Promise<VersionedRow | undefined> {
    return this.pending.get(key) ?? ((await this.store.get(key)) as VersionedRow | undefined);
  }

  /** The visible value of one row (`undefined` when absent or deleted). */
  async get(key: string): Promise<unknown> {
    return this.visibility.value(await this.physical(key));
  }

  /** Buffer a row (bounded per row and per buffer); publishes the rows early past the buffer bound. */
  async put(key: string, value: unknown): Promise<void> {
    await this.write(key, [this.committed.checkpoint + 1, this.attempt, value]);
  }

  /** Buffer a deletion. */
  async del(key: string): Promise<void> {
    await this.write(key, [this.committed.checkpoint + 1, this.attempt]);
  }

  /** Record `version` over the row's previous versions. */
  private async write(key: string, version: RowVersion): Promise<void> {
    if (this.attempt < 0) throw new BatchCompileError("compile_batch_run_unknown", "a run opened read-only cannot be written");
    const row = this.visibility.write(await this.physical(key), version);
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(row));
    if (key.length > MAX_KEY_CHARS || bytes > MAX_ROW_BYTES) throw new BatchCompileError("compile_batch_row_too_large", `a batch compile row (${key.slice(0, 60)}) is ${bytes} bytes, over the ${MAX_ROW_BYTES}-byte row cap`);
    this.pending.set(key, row);
    this.pendingBytes += bytes;
    if (this.pending.size >= MAX_PENDING_ROWS || this.pendingBytes >= MAX_PENDING_BYTES) await this.publish(this.committed);
  }

  /**
   * Every visible row under `prefix` (from `from`), as of the scan's start:
   * the store's rows merged in key order with a snapshot of the buffered ones
   * (a buffered row supersedes the stored one, as it was written over it).
   */
  async *scan(prefix: string, from?: string): AsyncGenerator<SegmentRow> {
    const visibility = this.visibility;
    for await (const row of mergedRows(this.store.scan({ prefix, ...(from === undefined ? {} : { from }) }), this.bufferedUnder(prefix, from))) {
      const version = visibility.resolve(row.v as VersionedRow);
      if (version !== undefined && version.length >= 3) yield { k: row.k, v: version[2] };
    }
  }

  /** The buffered rows under `prefix` (from `from`), in key order. */
  private bufferedUnder(prefix: string, from: string | undefined): SegmentRow[] {
    const rows: SegmentRow[] = [];
    for (const [k, v] of this.pending) if (k.startsWith(prefix) && (from === undefined || k >= from)) rows.push({ k, v });
    return sortedByKey(rows);
  }

  /** Publish the buffered rows now, WITHOUT a checkpoint: durable, yet invisible to a later attempt unless checkpointed. */
  async persist(): Promise<void> {
    if (this.pending.size > 0) await this.publish(this.committed);
  }

  /** Every stored key under `prefix` that ANY version (committed or not, of any attempt) wrote a value to: raw evidence of intents. */
  async *keysEverWritten(prefix: string): AsyncGenerator<string> {
    for await (const row of this.store.scan({ prefix })) {
      const versioned = row.v as VersionedRow;
      if (versioned.c.length >= 3 || (versioned.p !== undefined && versioned.p.length >= 3)) yield row.k;
    }
  }

  /** Publish the buffer as a CHECKPOINT: the meta patched by `patch`, the live counters, and the units buffered so far. */
  async checkpoint(patch: Partial<Pick<RunMetaV1, "phase" | "cursor" | "identity">> = {}): Promise<void> {
    // A SNAPSHOT: a caller's cursor object (a walk position it keeps advancing) must not leak into a later early publication.
    await this.publish(structuredClone({ ...this.committed, ...patch, counters: { ...this.live }, checkpoint: this.committed.checkpoint + 1 }));
  }

  /** Move to `phase` with a fresh cursor, as a checkpoint. */
  async advance(phase: BatchPhase, cursor: Readonly<Record<string, unknown>> = {}): Promise<void> {
    this.live.batches += 1;
    await this.checkpoint({ phase, cursor });
  }

  /** Commit the buffered rows with `meta`. */
  private async publish(meta: RunMetaV1): Promise<void> {
    const rows = sortedByKey([...this.pending].map(([k, v]): SegmentRow => ({ k, v })));
    this.store = await this.store.commit({ rows, meta: { ...meta } });
    this.committed = meta;
    this.visibility = new Visibility(meta.checkpoint, meta.attempts, this.attempt);
    this.pending.clear();
    this.pendingBytes = 0;
  }
}

/** Merge stored rows with buffered rows (both in key order); a buffered row wins its key. */
async function* mergedRows(stored: AsyncIterable<SegmentRow>, buffered: readonly SegmentRow[]): AsyncGenerator<SegmentRow> {
  let at = 0;
  for await (const row of stored) {
    while (at < buffered.length && buffered[at]!.k < row.k) yield buffered[at++]!;
    if (at < buffered.length && buffered[at]!.k === row.k) yield buffered[at++]!;
    else yield row;
  }
  while (at < buffered.length) yield buffered[at++]!;
}

/** Whether a run in `phase` is still active. */
const activePhase = (phase: unknown): boolean => phase !== "done" && phase !== "superseded";

/** A complete indexed inventory, with all entries counting against the discovery limit. */
async function runInventory(root: string): Promise<{ ids: string[]; atCapacity: boolean }> {
  const listing = await listConfinedDirBounded(root, INDEXED_DIR, MAX_INDEXED_STORE_ENTRIES);
  if (listing.kind === "absent") return { ids: [], atCapacity: false };
  if (listing.kind !== "ok") throw new BatchCompileError("compile_batch_run_unknown", `the indexed stores directory cannot be listed in full (unreadable, or more than ${MAX_INDEXED_STORE_ENTRIES} entries); inspect the inventory and preserve the project before attempting recovery`);
  const ids = listing.entries.filter((entry) => entry.name.startsWith(RUN_STORE_PREFIX)).map((entry) => entry.name.slice(RUN_STORE_PREFIX.length)).sort();
  return { ids, atCapacity: listing.entries.length === MAX_INDEXED_STORE_ENTRIES };
}

/** The run ids of every run store of the project at `root`. */
export async function runIds(root: string): Promise<string[]> {
  return (await runInventory(root)).ids;
}

/** How a run inventory reads one run's meta. */
type RunMetaRead = (root: string, runId: string) => Promise<RunMetaV1>;

/** An ordinary reader's read: the run opened under this process's reader lease. */
const leasedRunMeta: RunMetaRead = async (root, runId) => (await BatchRun.open(root, runId)).meta;

/**
 * The MAINTENANCE read, under the maintenance lock: the manifest leaf alone,
 * WITHOUT a reader lease (a restore is already the collector, so a lease would
 * be refused), no segment or snapshot opened; the same strict meta check as
 * {@link BatchRun.open}. Also the run retirement's inventory read.
 */
export async function unleasedRunMeta(root: string, runId: string): Promise<RunMetaV1> {
  assertRunId(runId);
  const store = `${RUN_STORE_PREFIX}${runId}`;
  const read = await readManifestLeaf(root, store);
  return checkedRunMeta(runId, read.kind === "ok" ? parseManifest(read.bytes, store).meta : null);
}

/** Find the active run and free-slot status from one complete inventory. */
export async function inspectActiveRun(root: string, readMeta: RunMetaRead = leasedRunMeta): Promise<{ active: string | null; atCapacity: boolean }> {
  const { ids, atCapacity } = await runInventory(root);
  const active: string[] = [];
  for (const id of ids) {
    // An unreadable run store refuses rather than hiding an active run.
    if (activePhase((await readMeta(root, id)).phase)) active.push(id);
  }
  if (active.length > 1) throw new BatchCompileError("compile_batch_run_active", `${active.length} batch compile runs are active (${active.join(", ")}); inspect .llmwiki/indexed by hand`);
  return { active: active[0] ?? null, atCapacity };
}

/** The active run's id, or null. Unreadable runs and multiple active runs refuse. */
export async function activeRunId(root: string, readMeta: RunMetaRead = leasedRunMeta): Promise<string | null> {
  return (await inspectActiveRun(root, readMeta)).active;
}

/** Whether any batch compile run of the project at `root` is active (a backup refuses then). */
export async function anyRunActive(root: string): Promise<boolean> {
  return (await activeRunId(root)) !== null;
}

/** {@link anyRunActive} for maintenance under the maintenance lock (a restore): read by {@link unleasedRunMeta}, opening no reader lease. */
export async function anyRunActiveUnleased(root: string): Promise<boolean> {
  return (await activeRunId(root, unleasedRunMeta)) !== null;
}
