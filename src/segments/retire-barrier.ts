/**
 * @file src/segments/retire-barrier.ts
 * @description The RETIREMENT BARRIER of a batch run retirement
 * (`../indexed/run-retire.ts`), `.llmwiki/indexed-retire.json`: the
 * publication fence that keeps late readers away from run stores while whole
 * stores are removed.
 *
 * WHY A FENCE. A segment collection is safe against a reader registering after
 * its census only because every manifest stays and references every segment it
 * keeps. A retirement removes whole stores, manifest included, so a reader
 * registering after the census could open a manifest just before its store
 * moves and then miss its segments. The retirement publishes this barrier
 * BEFORE its census: a reader registered earlier is in the census (and the
 * retirement refuses); every read made once the barrier is visible re-checks
 * it after the reader's own lease (`./reader-lease.ts`) and refuses
 * `indexed_retirement_in_progress`.
 *
 * LIVE OWNER ONLY. The barrier names its owner (a `lock-owner` record). Reads
 * refuse while that owner is live or cannot be classified, and while the leaf
 * cannot be read as a barrier. A barrier whose owner is positively gone (a
 * dead or reused pid) blocks nothing: each store's retirement commits with one
 * rename, so every interrupted state is consistent, and a crashed retirement
 * never leaves the project unreadable. The next retirement removes a stale
 * barrier (by identity) before it publishes its own.
 *
 * SCALE-DOWN. An explicit scale-down (`../scale/downgrade-apply.ts`) publishes
 * the same barrier, with its plan digest, before its census, for the same
 * reason: it moves whole stores (into its retained archive). Its own export
 * reads are admitted only through `./downgrade-access.ts`, which checks this
 * barrier's token ({@link barrierHeldBy}).
 *
 * LOCAL SCOPE. Liveness is the `lock-owner` classification (pid and start time
 * on THIS host), with its limits: a barrier written on another host (its host
 * tag differs, as a reader lease's would) cannot be classified here and blocks,
 * as an uncertain lease blocks a census. Nothing here supports concurrent use
 * of one project from several hosts.
 *
 * IDENTITY. The barrier is created only when absent (create-only), and removed
 * only when the leaf whose token was just read is still that exact file
 * (device, inode, size, nanosecond mtime and ctime).
 *
 * INTERRUPTED PUBLICATION. The create-only writer can stop between its W, R
 * and F names (`../utils/publication-group.ts`). Such a group is recognized
 * only when its exact bytes are a barrier this build wrote (strict UTF-8,
 * closed schema, writer field order, a `serializeOwner` owner record) and its
 * owner is POSITIVELY stale: same host, then signal 0 failing ESRCH, or a
 * comparable epoch start identity that differs. Permission errors, other
 * errors, an equal or unreadable identity and a foreign host never authorize
 * anything (the incumbent liveness classification, which reads an unexpected
 * signal error as stale, is not used for this). Ordinary readers pass a
 * visible F+R only on that proof ({@link retireBarrierState}); writers also
 * see W or R without F ({@link retireFenceState}). Only
 * {@link clearStaleRetireBarrier}, under the writer's raw lock and after its
 * plan is proved current, re-proves and discards such a group (an expected
 * plan digest is bound inside that proof), leaving all three names absent and
 * synced before a new token is minted. Nothing is ever promoted or published
 * for the stopped owner.
 */

import { createHash, randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWrite } from "../utils/atomic-write.js";
import { fsyncConfinedDirectory, unlinkConfinedLeafIfIdentity } from "../utils/confined-delete.js";
import { openConfinedLeaf, readConfirmedBufferOrElse } from "../utils/confined-read.js";
import { classifyOwnerLiveness, parseOwner, readProcessStartTime, serializeOwner } from "../utils/lock-owner.js";
import { discardProvenPublication, observePublicationGroup, publicationAliasesMayExist } from "../utils/publication-group.js";
import { IndexedStoreError } from "./contracts.js";

/** The barrier leaf, relative to the project root. */
const RETIRE_BARRIER_PATH = ".llmwiki/indexed-retire.json";
const BARRIER_FORMAT = "llmwiki-indexed-retire-barrier";
/** A barrier is tiny; anything larger is not one. */
const MAX_BARRIER_BYTES = 4096;
const PRIVATE_FILE_MODE = 0o600;
/**
 * The only start identity a positive staleness proof compares: the versioned
 * epoch exactly as the writer renders a number (`unix:<n>`, no leading zero),
 * so two equal epochs can never compare unequal as strings.
 */
const EPOCH_IDENTITY = /^unix:(?:0|[1-9]\d{0,19})$/u;
/** The largest pid a signal can address. */
const MAX_OWNER_PID = 2147483647;
/** The longest legacy start-time rendering accepted as a typed field. */
const MAX_START_TIME_CHARS = 200;

/** The durable barrier. */
interface RetireBarrierV1 {
  readonly format: typeof BARRIER_FORMAT;
  readonly version: 1;
  readonly token: string;
  readonly planDigest: string;
  /** The writing host's tag (a short digest of its name, as in a reader lease). */
  readonly host: string;
  /** The owner record (`lock-owner` format) of the retiring process. */
  readonly owner: unknown;
}

/** A leaf's exact identity: the file and its content stamp (an in-place rewrite changes the stamp). */
export type LeafStamp = Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">;

/** One confined read of a leaf with the identity its bytes came from. */
export type StampedRead = { readonly kind: "absent" } | { readonly kind: "unavailable" } | { readonly kind: "ok"; readonly body: Buffer; readonly stamp: LeafStamp };

/** What a writer must respect: the reader's view plus an interrupted publication, with a stale barrier's plan. */
export type RetireFenceState =
  | { readonly kind: "absent" }
  | { readonly kind: "stale"; readonly planDigest: string | null }
  | { readonly kind: "blocking"; readonly reason: string };

/** What one look at the barrier found. `stale`: its owner is positively gone, so it blocks nothing. */
export type RetireBarrierState =
  | { readonly kind: "absent" }
  | { readonly kind: "stale" }
  | { readonly kind: "blocking"; readonly reason: string };

/**
 * Read the regular single-link leaf `relPath` under canonical `root` through
 * ONE confined open, with the exact identity of the file its bytes came from.
 */
export async function readStampedLeaf(root: string, relPath: string, maxBytes: number): Promise<StampedRead> {
  const leaf = path.join(root, relPath);
  const opened = await openConfinedLeaf(root, leaf, path.dirname(leaf), { requireSingleLink: true });
  if (opened.kind !== "confirmed") return opened;
  let stamp: BigIntStats;
  try { stamp = await opened.handle.stat({ bigint: true }); } catch { await opened.handle.close().catch(() => {}); return { kind: "unavailable" }; }
  const read = await readConfirmedBufferOrElse(opened, maxBytes, () => ({ kind: "unavailable" as const }));
  return read.kind === "ok" ? { kind: "ok", body: read.body, stamp } : { kind: "unavailable" };
}

/** Whether `stat` is still exactly the file `stamp` was taken from. */
export function sameStamp(stamp: LeafStamp, stat: BigIntStats): boolean {
  return stat.dev === stamp.dev && stat.ino === stamp.ino && stat.size === stamp.size && stat.mtimeNs === stamp.mtimeNs && stat.ctimeNs === stamp.ctimeNs;
}

/** Whether the pathname still holds exactly the file state observed earlier. */
export async function matchesLeafStamp(root: string, leaf: string, stamp: LeafStamp): Promise<boolean> {
  const current = await lstat(path.join(root, leaf), { bigint: true }).catch(() => null);
  return current !== null && sameStamp(stamp, current);
}

/** This host's tag: a short digest of its name, so a barrier from another host is recognised. */
const hostTag = (): string => createHash("sha256").update(os.hostname()).digest("hex").slice(0, 8);

/** Whether `value` is a lowercase hex string of exactly `length` digits. */
const hexOf = (value: unknown, length: number): boolean => typeof value === "string" && value.length === length && /^[0-9a-f]+$/.test(value);

/** Whether `value` is a closed barrier object of this format and version. */
function hasBarrierShape(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join() === "format,host,owner,planDigest,token,version" && record.format === BARRIER_FORMAT && record.version === 1;
}

/** Whether a barrier's token, plan digest, host tag and owner record are well formed. */
function barrierFieldsValid(record: Record<string, unknown>): boolean {
  const fields = hexOf(record.token, 32) && hexOf(record.planDigest, 64) && hexOf(record.host, 8);
  return fields && parseOwner(JSON.stringify(record.owner ?? null)) !== null;
}

/** Whether `value` is a closed-shape barrier this build wrote. */
function isBarrier(value: unknown): value is RetireBarrierV1 {
  return hasBarrierShape(value) && barrierFieldsValid(value);
}

/** The barrier of canonical `root` with its leaf identity, `absent`, or `null` when the leaf is not a readable barrier. */
async function readBarrier(root: string): Promise<{ barrier: RetireBarrierV1; stamp: LeafStamp } | "absent" | null> {
  const read = await readStampedLeaf(root, RETIRE_BARRIER_PATH, MAX_BARRIER_BYTES);
  if (read.kind === "absent") return "absent";
  if (read.kind !== "ok") return null;
  let value: unknown;
  try { value = JSON.parse(read.body.toString("utf8")); } catch { return null; }
  return isBarrier(value) ? { barrier: value, stamp: read.stamp } : null;
}

/** Whether the barrier's owner is positively gone (a dead or reused pid on THIS host; another host's owner cannot be classified). */
function ownerStale(barrier: RetireBarrierV1): boolean {
  const owner = parseOwner(JSON.stringify(barrier.owner));
  return barrier.host === hostTag() && owner !== null && classifyOwnerLiveness(owner) === "stale";
}

/** Whether `value` is a plain (non-null, non-array) object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether `owner`'s own keys are exactly the writer's keys present, in writer order (pid, startTime, identity). */
function hasWriterKeyOrder(owner: Record<string, unknown>): boolean {
  const order = ["pid", "startTime", "identity"].filter((key) => Object.hasOwn(owner, key));
  return Object.keys(owner).join() === order.join();
}

/** Whether `pid` is a safe integer in the writer's pid range. */
function isWriterPid(pid: unknown): boolean {
  return Number.isSafeInteger(pid) && (pid as number) >= 1 && (pid as number) <= MAX_OWNER_PID;
}

/** Whether an optional start time is absent or a string within the writer's bound. */
function isWriterStartTime(startTime: unknown): boolean {
  return startTime === undefined || (typeof startTime === "string" && startTime.length <= MAX_START_TIME_CHARS);
}

/** Whether an optional identity is absent or an epoch identity string. */
function isWriterIdentity(identity: unknown): boolean {
  return identity === undefined || (typeof identity === "string" && EPOCH_IDENTITY.test(identity));
}

/** The owner record exactly as `serializeOwner` writes it (pid, then optional typed start fields, in that order), or null. */
function writerOwner(value: unknown): { readonly pid: number; readonly identity?: string } | null {
  if (!isPlainRecord(value)) return null;
  if (!hasWriterKeyOrder(value) || !isWriterPid(value.pid)) return null;
  if (!isWriterStartTime(value.startTime) || !isWriterIdentity(value.identity)) return null;
  return value as { pid: number; identity?: string };
}

/**
 * The barrier `body` holds when its ORIGINAL bytes are exactly what
 * {@link publishRetireBarrier} writes (strict UTF-8 with no byte order mark
 * stripped, closed schema, writer order, one trailing newline), or null.
 */
function canonicalBarrier(body: Buffer): RetireBarrierV1 | null {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body)); } catch { return null; }
  if (!isBarrier(value) || writerOwner(value.owner) === null) return null;
  const { format, version, token, planDigest, host, owner } = value;
  return body.equals(Buffer.from(`${JSON.stringify({ format, version, token, planDigest, host, owner })}\n`, "utf8")) ? value : null;
}

/**
 * LABELLED SEAM: the two observations a POSITIVE staleness proof makes of an
 * owner pid (signal 0, and the current epoch start identity). Focused tests
 * may replace them deterministically; they never broaden what counts as stale.
 */
export const ownerObservation = {
  /** `gone` only on ESRCH; `present` when signal 0 succeeds; anything else is `unknown`. */
  signal(pid: number): "gone" | "present" | "unknown" {
    try { process.kill(pid, 0); return "present"; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown"; }
  },
  startIdentity: (pid: number): string | null => readProcessStartTime(pid),
};

/** Whether `barrier`'s owner is POSITIVELY gone on this host (see INTERRUPTED PUBLICATION); never inferred from an absence of evidence. */
function ownerPositivelyStale(barrier: RetireBarrierV1): boolean {
  const owner = writerOwner(barrier.owner);
  if (owner === null || barrier.host !== hostTag()) return false;
  const signal = ownerObservation.signal(owner.pid);
  if (signal === "gone") return true;
  if (signal !== "present" || owner.identity === undefined) return false;
  const current = ownerObservation.startIdentity(owner.pid);
  return current !== null && EPOCH_IDENTITY.test(current) && current !== owner.identity;
}

/** The provably stale barrier an interrupted publication of `root` holds, or null when it is anything else. */
async function staleInterruptedBarrier(root: string, states: readonly string[]): Promise<RetireBarrierV1 | null> {
  const observed = await observePublicationGroup(path.join(root, RETIRE_BARRIER_PATH), root, MAX_BARRIER_BYTES);
  if (observed.kind !== "group" || !states.includes(observed.state)) return null;
  const barrier = canonicalBarrier(observed.body);
  return barrier !== null && ownerPositivelyStale(barrier) ? barrier : null;
}

/** What the barrier of canonical `root` means for a reader or a retirement (see the file comment). */
export async function retireBarrierState(root: string): Promise<RetireBarrierState> {
  const read = await readBarrier(root);
  if (read === "absent") return { kind: "absent" };
  // A settled single-link F beside a visible reserved sibling is no state the writer leaves (an exact R+F has two links): ambiguous, it blocks.
  if (read !== null && (await publicationAliasesMayExist(path.join(root, RETIRE_BARRIER_PATH)))) {
    return { kind: "blocking", reason: `${RETIRE_BARRIER_PATH} has an unrelated reserved sibling (.tmp or .writing); if no \`llmwiki catalog runs --retire\` is running, inspect them by hand` };
  }
  // A visible F+R passes ordinary readers only as an exact barrier group whose owner is positively stale.
  if (read === null && (await staleInterruptedBarrier(root, ["RF"])) !== null) return { kind: "stale" };
  if (read === null) return { kind: "blocking", reason: `${RETIRE_BARRIER_PATH} is not a readable retirement barrier; if no \`llmwiki catalog runs --retire\` is running, inspect and remove it by hand` };
  if (ownerStale(read.barrier)) return { kind: "stale" };
  return { kind: "blocking", reason: `a batch run retirement or scale-down holds ${RETIRE_BARRIER_PATH} and its owner may be running; retry once it ends` };
}

/** Whether canonical `root`'s barrier is exactly the one carrying `token` for `planDigest`, owned by THIS process on this host (a scale-down's owner check). */
export async function barrierHeldBy(root: string, token: string, planDigest: string): Promise<boolean> {
  const read = await readBarrier(root);
  if (read === null || read === "absent" || read.barrier.token !== token || read.barrier.planDigest !== planDigest) return false;
  // This process INCARNATION: its pid, and a recorded start identity positively observed live (a missing or other start is not proof).
  const owner = parseOwner(JSON.stringify(read.barrier.owner));
  return read.barrier.host === hostTag() && owner !== null && owner.pid === process.pid && classifyOwnerLiveness(owner) === "live";
}

/** The settled barrier's fence for a writer, with a stale barrier's plan. */
async function settledFence(root: string): Promise<RetireFenceState> {
  const state = await retireBarrierState(root);
  if (state.kind !== "stale") return state;
  const read = await readBarrier(root);
  return { kind: "stale", planDigest: read !== null && read !== "absent" ? read.barrier.planDigest : null };
}

/**
 * The fence a WRITER (retirement inventory, scale-down maintenance and cancel)
 * must respect for canonical `root`: the settled barrier as readers see it,
 * and also an interrupted publication (W or R without F, or F+R), which is
 * stale only on the full proof and blocks otherwise. Read-only.
 */
export async function retireFenceState(root: string): Promise<RetireFenceState> {
  const final = path.join(root, RETIRE_BARRIER_PATH);
  if (!(await publicationAliasesMayExist(final))) return settledFence(root);
  const observed = await observePublicationGroup(final, root, MAX_BARRIER_BYTES);
  if (observed.kind === "absent" || (observed.kind === "group" && observed.state === "F")) return settledFence(root);
  const barrier = observed.kind === "group" ? canonicalBarrier(observed.body) : null;
  if (barrier === null) return { kind: "blocking", reason: `an interrupted barrier publication at ${RETIRE_BARRIER_PATH} is not one this build wrote (${observed.kind === "refused" ? observed.reason : "not a complete barrier"}); inspect it by hand` };
  if (!ownerPositivelyStale(barrier)) return { kind: "blocking", reason: `an interrupted barrier publication at ${RETIRE_BARRIER_PATH} has an owner that may be running or cannot be proved gone; retry once it ends` };
  return { kind: "stale", planDigest: barrier.planDigest };
}

/** Remove a settled stale barrier (of `plan`, when given): absent, removed, or another plan's (left alone). */
async function clearSettledStale(root: string, plan: string | undefined): Promise<"cleared" | "absent" | "other-plan"> {
  const state = await retireBarrierState(root);
  if (state.kind === "absent") return "absent";
  if (state.kind === "blocking") throw new IndexedStoreError("indexed_retirement_in_progress", state.reason);
  const read = await readBarrier(root);
  if (plan !== undefined && read !== null && read !== "absent" && read.barrier.planDigest !== plan) return "other-plan";
  await removeRetireBarrier(root, "stale", plan);
  return "cleared";
}

/**
 * Under the caller's raw project lock, after its plan is proved current:
 * clear a stale barrier (of `plan`, when given; another plan's is left alone)
 * before a new one is published. An interrupted publication is re-observed,
 * re-proved (exact bytes, positively stale owner, the plan bound inside the
 * proof) and discarded with every name absent and synced; anything unproved
 * refuses `indexed_retirement_in_progress` with exactly what was removed.
 */
export async function clearStaleRetireBarrier(root: string, plan?: string): Promise<"cleared" | "absent" | "other-plan"> {
  const final = path.join(root, RETIRE_BARRIER_PATH);
  if (!(await publicationAliasesMayExist(final))) return clearSettledStale(root, plan);
  const verdict = { otherPlan: false };
  try {
    await discardProvenPublication(final, root, MAX_BARRIER_BYTES, (_state, body) => {
      const barrier = canonicalBarrier(body);
      if (barrier === null || !ownerPositivelyStale(barrier)) return false;
      verdict.otherPlan = plan !== undefined && barrier.planDigest !== plan;
      return !verdict.otherPlan;
    });
  } catch (error) {
    if (verdict.otherPlan) return "other-plan";
    throw new IndexedStoreError("indexed_retirement_in_progress", `the interrupted retirement barrier was not cleared: ${error instanceof Error ? error.message : String(error)}`);
  }
  return "cleared";
}

/** Refuse a read of canonical `root`'s indexed stores while a barrier blocks it (one `lstat` when there is none). */
export async function assertNoLiveRetirement(root: string): Promise<void> {
  const present = await lstat(path.join(root, RETIRE_BARRIER_PATH)).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT");
  if (!present) return;
  const state = await retireBarrierState(root);
  if (state.kind === "blocking") throw new IndexedStoreError("indexed_retirement_in_progress", state.reason);
}

/** Durably publish this process's barrier for `planDigest` (refusing an existing one); returns its token. */
export async function publishRetireBarrier(root: string, planDigest: string): Promise<string> {
  const token = randomBytes(16).toString("hex");
  const barrier: RetireBarrierV1 = { format: BARRIER_FORMAT, version: 1, token, planDigest, host: hostTag(), owner: JSON.parse(serializeOwner(process.pid)) as unknown };
  await atomicWrite(path.join(root, RETIRE_BARRIER_PATH), `${JSON.stringify(barrier)}\n`, { confineRoot: root, exactParent: true, createOnly: true, mode: PRIVATE_FILE_MODE });
  return token;
}

/**
 * Durably remove the barrier: the one carrying `token`, or with `"stale"` one
 * whose owner is positively gone (of `planDigest`, when given, checked on the
 * same read). Only the exact leaf the token was read from is unlinked;
 * anything else refuses and nothing is removed.
 */
export async function removeRetireBarrier(root: string, which: { readonly token: string } | "stale", planDigest?: string): Promise<void> {
  const read = await readBarrier(root);
  if (read === null || read === "absent" || (planDigest !== undefined && read.barrier.planDigest !== planDigest) || !(which === "stale" ? ownerStale(read.barrier) : read.barrier.token === which.token)) throw new IndexedStoreError("indexed_retirement_in_progress", "the retirement barrier is not the one expected; nothing was removed");
  const leaf = path.join(root, RETIRE_BARRIER_PATH);
  const removed = await unlinkConfinedLeafIfIdentity(root, leaf, path.dirname(leaf), (now) => sameStamp(read.stamp, now));
  if (removed !== "unlinked") throw new IndexedStoreError("indexed_retirement_in_progress", "the retirement barrier changed while it was being removed; nothing was removed");
  await fsyncConfinedDirectory(root, path.dirname(leaf));
}
