/**
 * @file src/segments/reader-lease.ts
 * @description PROCESS READER LEASES: how a process that reads segment
 * snapshots makes itself visible to a collector in another process.
 *
 * A snapshot (`SegmentStore`) reads its manifest once and opens segments
 * lazily, so nothing it holds protects a segment it has not opened yet. A
 * collector that deletes segments no longer referenced by the CURRENT
 * manifest must therefore know which processes may hold an OLDER one.
 *
 * THE SUPPORTED-READER PROTOCOL. Before a process's first manifest read of a
 * project's indexed stores, it publishes one complete lease record
 * (create-only, atomically linked into place, 0600 in a 0700 directory; not
 * fsynced, see `publishLease`) at
 * `.llmwiki/indexed-readers/<host>-<pid>-<random>.lease`, naming its host tag,
 * pid and start time. The lease lives for the process (removed best-effort at
 * exit; a crashed process's lease is recognised as stale by pid and start
 * time). Every later read re-checks that the published lease is still the
 * same file (device and inode), and refuses once it is not. A process that
 * CANNOT publish its lease does not read: the manifest
 * read refuses with `indexed_reader_lease_unavailable`, because a collector
 * elsewhere could not know it exists. A project with no `.llmwiki/indexed`
 * directory registers nothing and writes nothing (the ordinary local path).
 *
 * WHY THIS COVERS EVERY SUPPORTED READER. A collector takes the project
 * mutation lock (so no manifest is published while it runs), THEN takes the
 * census of leases, THEN re-reads the manifests and deletes only what they do
 * not reference. A reader whose snapshot predates the current manifest read
 * it before the last publication, and published its lease before that read,
 * so its lease is in the census (or the reader has exited). A reader whose
 * lease appears after the census reads the current, protected manifest.
 *
 * LOCKED METADATA READS. A collection takes the RAW project lock and then
 * runs the read-only custody detection of the gate (`../indexed/maintenance-lock.ts`)
 * BEFORE it collects. Those detection reads run in a private scope bound to
 * the canonical root (`runWithLockedMetadataReads`) that registers no lease
 * and writes nothing: no manifest can be published while the lock is held,
 * and the scope returns nothing, so no snapshot it opened outlives it (a lazy
 * read of one afterwards registers, or refuses once collection began).
 *
 * IN THIS PROCESS. A collection refuses when this process has already
 * registered for the project (some earlier snapshot may still be in use) or
 * has a registration in flight (reserved synchronously on entry), and
 * while a collection runs every manifest read of that project in this process
 * refuses, except reads inside the owning restore's private scope
 * (`./restore-marker.ts`). A collection therefore runs in a fresh process.
 *
 * RESTORE. After the lease is visible, every read also refuses while a foreign
 * restore marker exists, so a restore that publishes its marker before its
 * census excludes every reader: one registered earlier is in the census, one
 * registering later sees the marker.
 *
 * RETIREMENT. The same holds for a batch run retirement's barrier
 * (`./retire-barrier.ts`), published before its census: every read after the
 * lease also refuses while a barrier whose owner may be running exists.
 *
 * SCALE-DOWN. A scale-down publishes that barrier too and then collects. Its
 * OWN export reads, and only those, are admitted like locked metadata reads
 * (no lease, past its own barrier) while its private scope, intent and live
 * barrier token agree (`./downgrade-access.ts`).
 *
 * MIXED VERSIONS. Builds without leases (and any external tool) are invisible
 * to the census; a collector requires the operator to assert that none runs.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { chmod, lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteNoReplace } from "../utils/atomic-write.js";
import { readConfinedLeafBuffer } from "../utils/confined-read.js";
import { listConfinedDirBounded } from "../utils/confined-dir.js";
import { ensureConfinedDirectory } from "../utils/confined-scaffold.js";
import { classifyOwnerLiveness, parseOwner, serializeOwner } from "../utils/lock-owner.js";
import { IndexedStoreError, INDEXED_DIR } from "./contracts.js";
import { holdsDowngradeAccess } from "./downgrade-access.js";
import { assertNoForeignRestore, holdsRestoreMarker } from "./restore-marker.js";
import { assertNoLiveRetirement } from "./retire-barrier.js";

/** Where leases live, relative to the project root. */
const READERS_DIR = ".llmwiki/indexed-readers";
/** The format tag of a lease record. */
const LEASE_FORMAT = "llmwiki-indexed-reader-lease";
/** A lease record is tiny; anything larger is not ours. */
const MAX_LEASE_BYTES = 4096;
/** Most leaves a census lists before it refuses as uncertain. */
const MAX_CENSUS_LEAVES = 100_000;
/** Lease leaves: host tag, pid, random suffix; optionally an atomic writer's scratch suffix. */
const LEASE_NAME = /^([0-9a-f]{8})-(\d{1,10})-[0-9a-f]{8}\.lease(\.tmp|\.writing)?$/;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** The lease file this process published for one canonical root, by identity. */
interface PublishedLease { readonly file: string; readonly dev: bigint; readonly ino: bigint }
/** Canonical roots this process registered for: the publication of its lease. */
const registered = new Map<string, Promise<PublishedLease>>();
/** Canonical roots this process is collecting. */
const collecting = new Set<string>();
/**
 * Registrations in flight in this process, reserved SYNCHRONOUSLY on entry
 * (before any await), so a collection or restore can never start while a read
 * of this process is between its admission check and its registration.
 */
let registrationsInFlight = 0;
/** The canonical root whose locked, lease-free metadata reads the current async context runs. */
const lockedMetadataScope = new AsyncLocalStorage<string>();
/** Lease files to remove when this process exits. */
const ownLeases = new Set<string>();
let exitHookInstalled = false;

/** This host's tag: a short digest of its name, so a lease from another host is recognised. */
function hostTag(): string {
  return createHash("sha256").update(os.hostname()).digest("hex").slice(0, 8);
}

/** Refuse a read (or a collection) of the indexed stores. */
function refuse(message: string): never {
  throw new IndexedStoreError("indexed_reader_lease_unavailable", message);
}

/** The canonical project root. */
export async function canonicalRoot(root: string): Promise<string> {
  try { return await realpath(root); } catch { return refuse(`the project root ${root} cannot be resolved`); }
}

/** Whether `.llmwiki/indexed` may exist: anything but a proved absence counts. */
async function indexedMayExist(root: string): Promise<boolean> {
  try { await lstat(path.join(root, INDEXED_DIR)); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

/** Remove this process's leases at exit (best effort; a stale one is recognised by pid and start time). */
function removeLeasesAtExit(): void {
  for (const file of ownLeases) { try { unlinkSync(file); } catch { /* the lease is stale once this process is gone */ } }
}

/**
 * Publish one complete lease record for this process under `root`; returns its identity.
 *
 * WHY NOT DURABLE. A lease protects readers that are ALIVE on this host, so it
 * needs atomic cross-process visibility (a confined, create-only link of a
 * complete record, 0600) and not power-loss durability: a host crash that could
 * lose unsynced bytes also ends every reader the lease protects. The write is
 * therefore not fsynced. The accepted consequence is availability, not safety:
 * after a crash, a torn record, or the writer's random-suffix scratch leaf
 * (`<lease>.<hex>.tmp`, which `LEASE_NAME` does not recognise), is classified
 * `uncertain`, which refuses every collection until an operator inspects and
 * removes it. Nothing removes or reclassifies such residue automatically.
 */
async function publishLease(root: string): Promise<PublishedLease> {
  if (await ensureConfinedDirectory(root, READERS_DIR)) await chmod(path.join(root, READERS_DIR), PRIVATE_DIR_MODE);
  const file = path.join(root, READERS_DIR, `${hostTag()}-${process.pid}-${randomBytes(4).toString("hex")}.lease`);
  const record = { format: LEASE_FORMAT, version: 1, host: hostTag(), owner: JSON.parse(serializeOwner(process.pid)) as unknown, createdAt: new Date().toISOString() };
  await atomicWriteNoReplace(file, `${JSON.stringify(record)}\n`, { confineRoot: root, exactParent: true, mode: PRIVATE_FILE_MODE });
  ownLeases.add(file);
  if (!exitHookInstalled) { process.once("exit", removeLeasesAtExit); exitHookInstalled = true; }
  const stat = await lstat(file, { bigint: true });
  return { file, dev: stat.dev, ino: stat.ino };
}

/**
 * Refuse unless this process's published lease is still the same file. A
 * lease that vanished or was replaced (the lease removed by hand, or the
 * project root deleted and recreated at the same path) no longer tells a
 * collector about snapshots this process may hold, so nothing more is read.
 */
async function assertLeaseIntact(lease: PublishedLease): Promise<void> {
  const stat = await lstat(lease.file, { bigint: true }).catch(() => null);
  if (stat === null || !stat.isFile() || stat.dev !== lease.dev || stat.ino !== lease.ino) {
    refuse(`this process's reader lease ${path.basename(lease.file)} was removed or replaced (the project root may have been recreated); snapshots it held are no longer protected, so restart the process`);
  }
}

/** Whether the caller is the restore that owns canonical `root`'s marker: its private scope, and the marker PRESENT with its exact token. */
async function ownRestoreAdmitted(canonical: string): Promise<boolean> {
  return holdsRestoreMarker(canonical);
}

/**
 * Register this process as a reader of `root`'s indexed stores, before a
 * manifest read. Returns `false` (nothing written) when `.llmwiki/indexed` is
 * proved absent, unless `force`. Refuses when the lease cannot be published or
 * when this process is collecting the project.
 */
export async function ensureReaderLease(root: string, force = false): Promise<boolean> {
  registrationsInFlight += 1;
  try {
    return await registerReader(root, force);
  } finally {
    registrationsInFlight -= 1;
  }
}

/** Start publishing this process's lease for `canonical`, remembered for later reads. */
function startPublication(canonical: string): Promise<PublishedLease> {
  const publication = publishLease(canonical);
  registered.set(canonical, publication);
  return publication;
}

/** The published lease; a failed publication is forgotten (so a later read retries) and refuses. */
async function awaitPublication(canonical: string, publication: Promise<PublishedLease>): Promise<PublishedLease> {
  try {
    return await publication;
  } catch (error) {
    if (registered.get(canonical) === publication) registered.delete(canonical);
    return refuse(`this process could not register as a reader of ${READERS_DIR} (${error instanceof Error ? error.message : String(error)}); a collector could not know it reads, so nothing was read`);
  }
}

/** Whether this read of `canonical` is lease-free: a collector's locked metadata read, or the scale-down's own scoped read. */
async function unleasedRead(canonical: string): Promise<boolean> {
  const downgrading = await holdsDowngradeAccess(canonical);
  if (collecting.has(canonical) && !downgrading && !(await ownRestoreAdmitted(canonical))) refuse(`this process is collecting ${canonical}'s indexed stores; no snapshot may be opened until it ends`);
  return lockedMetadataScope.getStore() === canonical || downgrading;
}

/** The body of {@link ensureReaderLease}, run while its registration is reserved. */
async function registerReader(root: string, force: boolean): Promise<boolean> {
  const canonical = await canonicalRoot(root);
  if (await unleasedRead(canonical)) {
    // Under the raw project lock, before collection: read without a lease, still refusing a foreign restore.
    await assertNoForeignRestore(canonical);
    return force || indexedMayExist(canonical);
  }
  const publication = registered.get(canonical) ?? (force || (await indexedMayExist(canonical)) ? startPublication(canonical) : undefined);
  if (publication === undefined) return false;
  await assertLeaseIntact(await awaitPublication(canonical, publication));
  // After the lease is visible: a restore marker or retirement barrier published before a census sees this lease or refuses this read.
  await assertNoForeignRestore(canonical);
  await assertNoLiveRetirement(canonical);
  return true;
}

/**
 * Run `work` as this process's collection of `canonical`: refused when this
 * process already registered there (an earlier snapshot may be in use), and
 * every manifest read of the project in this process refuses meanwhile.
 */
export async function asCollector<T>(canonical: string, work: () => Promise<T>): Promise<T> {
  assertCollectable(canonical);
  collecting.add(canonical);
  try { return await work(); } finally { collecting.delete(canonical); }
}

/**
 * Refuse unless this process may collect `canonical` now: it never registered
 * there, no registration is in flight, and no collection of it runs. A
 * synchronous check, so a caller can repeat it after an await.
 */
export function assertCollectable(canonical: string): void {
  if (registered.has(canonical)) refuse("this process has already read these indexed stores, so an earlier snapshot may still be in use; collect from a fresh process");
  if (registrationsInFlight > 0) refuse("a read in this process is registering as an indexed reader; collect from a fresh process");
  if (collecting.has(canonical)) refuse("a collection of these indexed stores is already running in this process");
}

/**
 * Run read-only `detect` with lease-free reads of canonical `root`, for a
 * collector holding the raw project lock. It resolves to nothing, so no
 * snapshot or iterator can leave the scope.
 */
export function runWithLockedMetadataReads(canonical: string, detect: () => Promise<void>): Promise<void> {
  return lockedMetadataScope.run(canonical, detect);
}

/** What a census found. Only a census with nothing `live` or `uncertain` admits a collection. */
export interface ReaderCensusV1 {
  /** Leases of running processes (names). */
  readonly live: readonly string[];
  /** Leases of processes that are gone (dead pid or reused pid); ignored. */
  readonly stale: readonly string[];
  /** Leaves that cannot be classified: malformed, foreign host, unobservable owner, unexpected names. */
  readonly uncertain: readonly string[];
}

/** The owner a complete lease record names, or null when the record is not one this build wrote for this host. */
function leaseOwner(body: Buffer): ReturnType<typeof parseOwner> {
  let record: { format?: unknown; version?: unknown; host?: unknown; owner?: unknown };
  try { record = JSON.parse(body.toString("utf8")) as typeof record; } catch { return null; }
  const ours = record.format === LEASE_FORMAT && record.version === 1 && record.host === hostTag();
  return ours ? parseOwner(JSON.stringify(record.owner ?? null)) : null;
}

/** Classify one lease leaf: a scratch leaf by its pid alone, a complete record by its owner. */
async function classifyLease(root: string, name: string, kind: string): Promise<keyof ReaderCensusV1> {
  const match = LEASE_NAME.exec(name);
  if (kind !== "file" || match === null || match[1] !== hostTag()) return "uncertain";
  const pid = Number(match[2]);
  if (match[3] !== undefined) return livenessArm({ pid });
  const dir = path.join(root, READERS_DIR);
  const read = await readConfinedLeafBuffer(root, path.join(dir, name), dir, MAX_LEASE_BYTES, { requireSingleLink: true });
  if (read.kind !== "ok") return read.kind === "absent" ? "stale" : "uncertain";
  const owner = leaseOwner(read.body);
  return owner === null || owner.pid !== pid ? "uncertain" : livenessArm(owner);
}

/** The census arm of an owner: only a positive stale observation is stale. */
function livenessArm(owner: Parameters<typeof classifyOwnerLiveness>[0]): keyof ReaderCensusV1 {
  const liveness = classifyOwnerLiveness(owner);
  return liveness === "stale" ? "stale" : liveness === "live" ? "live" : "uncertain";
}

/** Take the census of reader leases under `canonical` (call under the project mutation lock). */
export async function readerCensus(canonical: string): Promise<ReaderCensusV1> {
  const census = { live: [] as string[], stale: [] as string[], uncertain: [] as string[] };
  const listing = await listConfinedDirBounded(canonical, READERS_DIR, MAX_CENSUS_LEAVES);
  if (listing.kind === "absent") return census;
  if (listing.kind !== "ok") return { ...census, uncertain: [`${READERS_DIR} (cannot be listed in full)`] };
  for (const entry of listing.entries) census[await classifyLease(canonical, entry.name, entry.kind)].push(entry.name);
  return census;
}
