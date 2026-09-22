/**
 * @file src/utils/lock-owner.ts
 * @description The lock OWNER record + PID-reuse-safe liveness for `lock.ts`.
 *
 * The lock leaf records WHO holds it. Historically that was a bare decimal
 * `process.pid`, and staleness was `!process.kill(pid, 0)`. That liveness is
 * fooled by PID REUSE: when the holder dies and the OS recycles its PID for an
 * unrelated process, `process.kill(pid, 0)` succeeds → the lock looks "alive"
 * forever → it is never reclaimed and the project wedges.
 *
 * This module records a process START-TIME alongside the PID as a best-effort,
 * EXTERNALLY-OBSERVABLE boot identity (a reused PID names a DIFFERENT process with
 * a different start time). Staleness is then: the PID is dead, OR the PID is alive
 * but its CURRENT start time differs from the recorded one (PID was reused).
 *
 * BACKWARD COMPATIBLE: a leaf written by an older build (a bare numeric PID, no
 * start time) falls back to the prior PID-only liveness — no regression for an
 * in-flight lock or any other lock user. The start time is a best-effort signal:
 * when it cannot be read (an unsupported platform / `ps` failure) the check
 * degrades to PID-only liveness rather than failing.
 *
 * WHAT THAT DEGRADATION NOW COSTS FOR A FOREIGN PID, stated because respecting
 * unsignalable processes changed it. On a host where another user's start time
 * cannot be read at all — Linux `hidepid=2`, a hardened container — a foreign
 * pid is EPERM (alive) and its current start time is `null` ("unreadable → trust
 * the recorded identity"), so NO evidence can ever show it stale. For a foreign
 * pid the fallback is therefore not "PID-only liveness" but PERMANENTLY ALIVE,
 * and a lock recorded under a REUSED foreign pid is unreclaimable until an
 * operator removes the leaf by hand.
 *
 * That is accepted as the correct trade rather than overlooked: silently
 * stealing a lock from a live holder — or clearing a live executor's fence —
 * corrupts work, while wedging is visible, diagnosable and manually escapable.
 * The narrower fix (trusting `ps` over the signal probe when both are available)
 * would reintroduce the collapse this file exists to prevent on every host where
 * `ps` is the thing that is restricted.
 *
 * WHAT THIS MODULE DOES AND DOES NOT PROVE, stated because callers build safety
 * preconditions on it. It answers "is the process this record names still
 * running", against two hazards: PID REUSE (recorded start time vs current) and
 * SIGNAL PERMISSION (an unsignalable process is alive, not dead). It does NOT
 * establish process identity across a PID NAMESPACE: a container and its host
 * number processes independently, so a recorded pid observed from the other side
 * of a namespace boundary is a different process or none at all, and both the
 * signal probe and `ps` answer about the WRONG one. Closing that needs a host
 * identity on the record — see the design gap noted on
 * `PreparationExecutionOwnerV1` — and no check here should be read as covering it.
 */

import { execFileSync } from "node:child_process";

/**
 * The inclusive upper bound Node accepts before `process.kill` rejects the
 * ARGUMENT rather than answering about a process.
 */
const MAX_SIGNALABLE_PID = 2147483647;

/**
 * Whether `pid` is a value a signal-0 probe can answer a real question about.
 *
 * NODE VALIDATES IN FRONT OF THE SYSCALL, so the POSIX errno set is not the
 * whole story and reasoning that stopped at ESRCH/EPERM was wrong at this layer.
 * Measured, all four shapes:
 *
 *  - `1.5` and `2147483648` throw `ERR_INVALID_ARG_TYPE` — a TypeError carrying
 *    NO errno, which every "which errno was it" branch reads as GONE;
 *  - `0` and `-1` SUCCEED, because POSIX gives them process-GROUP meaning and
 *    the caller's own group always exists. A planted or corrupt `{pid: 0}` leaf
 *    therefore reads ALIVE unconditionally and its lock can never be reclaimed —
 *    the guard-that-strands class, with no escape but deleting the leaf by hand.
 *
 * GATING BOTH READERS ON THIS IS WHAT MAKES THE ERRNO QUESTION SIMPLE AGAIN.
 * With no unbounded pid able to reach {@link isProcessAlive}, signal 0 can only
 * fail EPERM or ESRCH, so the unknown-code arm there is unreachable rather than
 * defended by an argument — and the two consumers, which want opposite fail
 * directions for an unknown code, no longer have to be reasoned about separately.
 */
export function isSignalablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= MAX_SIGNALABLE_PID;
}

/** A parsed lock owner: the PID and, when recorded, the holder's process start time. */
export interface LockOwner {
  /** The decimal PID recorded in the leaf. */
  pid: number;
  /** The holder's process start time, when the leaf carried one (new format). */
  startTime?: string;
  /** Present on dual-format lock records, including unrecognised future formats. */
  identity?: string;
}

/** This process's start time, populated only when lock behavior first needs it. */
let cachedSelfStartTime: string | null | undefined;

function selfStartTime(): string | null {
  if (cachedSelfStartTime === undefined) {
    cachedSelfStartTime = readProcessStartTime(process.pid);
  }
  return cachedSelfStartTime;
}

/**
 * Dual-write the public ambient timestamp and the new epoch identity. Old readers
 * ignore identity and retain their baseline comparison; new readers prefer it.
 * Mixed-version readers retain the baseline timezone hazard, not a new format
 * mismatch. Omitting startTime would disable old readers' PID-reuse recovery.
 */
export function serializeOwner(pid: number): string {
  const identity = pid === process.pid ? selfStartTime() : readProcessStartTime(pid);
  const startTime = readLegacyProcessStartTime(pid);
  return JSON.stringify({ pid, ...(startTime === null ? {} : { startTime }),
    ...(identity === null ? {} : { identity }) });
}

/** Read the exact ambient ps rendering used by public lock readers and writers. */
function readLegacyProcessStartTime(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Parse leaf TEXT into a {@link LockOwner}, or `null` when it carries no usable
 * owner. Accepts BOTH formats: the new `{pid, startTime?}` JSON object AND a
 * legacy bare decimal PID. Any other shape (garbage / empty / non-numeric pid)
 * yields `null` (treated as stale upstream).
 *
 * @param text - The raw leaf text (already size-capped by the caller).
 */
export function parseOwner(text: string): LockOwner | null {
  const trimmed = text.trim();
  const fromJson = parseJsonOwner(trimmed);
  const owner = fromJson === undefined ? legacyOwner(trimmed) : fromJson;
  // THE BOUND IS APPLIED ONCE, AFTER BOTH SHAPES, because both admit the values
  // it rejects: the JSON leg took any finite number, and the legacy leg runs
  // `parseInt`, which happily yields `0` from "0" and truncates "1.5" to 1. A
  // check on one of them would have left the other open — and an unusable owner
  // is NO usable owner, which upstream already treats as stale and reclaimable.
  return owner !== null && isSignalablePid(owner.pid) ? owner : null;
}

/** A legacy leaf is a bare decimal integer and nothing else. */
const LEGACY_PID_TEXT = /^\d+$/u;

/**
 * The legacy bare-decimal leaf shape, before the owner record became JSON.
 *
 * MATCHED, NOT SCAVENGED. `parseInt` reads a prefix and discards the rest, so it
 * TRUNCATES "1.5" to 1 and "12abc" to 12 — turning malformed content into a
 * confident, in-range pid that the bound above then happily accepts. That is how
 * a corrupt leaf comes to name `init`, and with an unsignalable process now
 * correctly read as alive, such a lock would never be reclaimable again.
 * Every leaf a previous build wrote came from `String(pid)`, so requiring the
 * whole text to be decimal digits rejects only content no build ever produced.
 */
function legacyOwner(text: string): LockOwner | null {
  return LEGACY_PID_TEXT.test(text) ? { pid: Number(text) } : null;
}

/** Parse the JSON owner shape; `undefined` when `text` is not a JSON object (try legacy). */
function parseJsonOwner(text: string): LockOwner | null | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const obj = JSON.parse(text) as { pid?: unknown; startTime?: unknown; identity?: unknown };
    if (typeof obj.pid !== "number" || !Number.isFinite(obj.pid)) return null;
    // Keep the in-memory owner contract used by strict lease consumers: its
    // startTime is the preferred identity, regardless of the wire field name.
    const identity = typeof obj.identity === "string" ? obj.identity : obj.startTime;
    const startTime = typeof identity === "string" ? identity : undefined;
    return { pid: obj.pid, startTime, ...(typeof obj.identity === "string" ? { identity: obj.identity } : {}) };
  } catch {
    return null;
  }
}

/**
 * Signal-0 failures that are POSITIVE EVIDENCE THE PROCESS EXISTS.
 *
 * The kernel had to FIND the process to decide this uid may not signal it, so a
 * denied probe answers "alive", not "gone".
 */
const SIGNAL_DENIED_CODES = new Set(["EPERM", "EACCES"]);

/**
 * Check whether a process with the given PID is still running.
 *
 * `process.kill(pid, 0)` FAILS FOR TWO ENTIRELY DIFFERENT REASONS and the
 * distinction is the whole answer: ESRCH means no such process; EPERM means the
 * process EXISTS and belongs to another uid. A bare `catch { return false }`
 * collapsed them, so every unsignalable live process read as dead — reachable
 * whenever the holder and the caller are different users: a service-account or
 * daemon executor, a sudo-launched compile, a CI runner's own project directory,
 * a shared workspace. Downstream that meant a live executor's fence was cleared
 * and a live holder's lock was reclaimed.
 *
 * THE START-TIME EVIDENCE COULD NOT SAVE IT, which is why this had to be fixed
 * here: `ps -o lstart=` reads a foreign process's start time perfectly well, but
 * {@link isOwnerStale} short-circuits on this probe before it ever compares.
 *
 * THE UNKNOWN-ERRNO DIRECTION IS A DECISION, not a default. `kill` with signal 0
 * can only fail EPERM or ESRCH, so there is no third case in practice; an
 * unrecognised code is treated as GONE because the lock reclamation this module
 * exists for wedges permanently if a lock is never reclaimable, whereas the
 * preparation callers apply their own further evidence before acting.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return SIGNAL_DENIED_CODES.has((error as NodeJS.ErrnoException).code ?? "");
  }
}

/**
 * The identity format prefix. VERSIONED so a reader can tell what it is holding.
 *
 * The prefix is the whole reason a format change is safe: without it, a record
 * written by an older build is indistinguishable from a corrupt one, and the only
 * way to compare is to guess. With it, "not this format" is a fact a reader can
 * establish and act on — see {@link comparableIdentity}.
 */
const IDENTITY_PREFIX = "unix:";

/** `ps` renders times through libc, so BOTH of these have to be pinned. */
const PINNED_TIME_ENV = { TZ: "UTC", LC_ALL: "C" } as const;

/**
 * Read a live PID's process START INSTANT as a timezone- and locale-invariant
 * identity, `unix:<epochSeconds>`.
 *
 * WHY THE PREVIOUS FORMAT WAS A DEFECT AND NOT A STYLE CHOICE. It stored what
 * `ps -o lstart=` printed, which libc renders in the AMBIENT timezone — so one
 * live process yields different identities to different readers:
 *
 *   ambient        Thu Jul 23 11:16:28 2026
 *   TZ=Asia/Tokyo  Fri Jul 24 03:16:28 2026     ← same pid, same instant
 *
 * A reader in another zone — a container beside its host, a cron job, a
 * `TZ=UTC` run — compares those and sees a MISMATCH, which
 * {@link isOwnerStale} reads as PID REUSE. It then reclaims a live holder's lock
 * and clears a live executor's fence. **A DST transition alone does it**, on one
 * correctly-configured host, because the same instant renders an hour apart
 * across the boundary.
 *
 * TWO HAZARDS, AND PINNING ONLY THE FIRST LEAVES THE DEFECT INTACT.
 *
 *  1. The RENDERING: `TZ`/`LC_ALL` are forced in the child environment, so what
 *     `ps` prints does not depend on the machine's zone or locale. Measured
 *     byte-identical across reads.
 *  2. The PARSE: `Date.parse` of a bare date string is ITSELF timezone-sensitive
 *     — the same text parses to two different instants under two zones. So the
 *     text is given an explicit UTC marker before parsing rather than being
 *     handed to the reader's ambient calendar.
 *
 * The rendering is an intermediate under a fixed zone; the IDENTITY is the epoch.
 * `etimes` would avoid the rendering entirely and does not exist on BSD `ps`, and
 * `etime` reports ELAPSED time, which advances between reads — so `now - elapsed`
 * is not stable enough to be an identity.
 *
 * @param pid - The process to identify.
 * @returns `unix:<epochSeconds>`, or null when the PID is gone or `ps` is
 * unavailable/unparseable — so liveness degrades rather than failing.
 */
export function readProcessStartTime(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ...PINNED_TIME_ENV },
    })
      .toString()
      .trim();
    return out.length > 0 ? identityFromUtcRendering(out) : null;
  } catch {
    return null;
  }
}

/** Turn a UTC-pinned `lstart` rendering into the versioned epoch identity. */
function identityFromUtcRendering(rendered: string): string | null {
  // THE MARKER IS LOAD-BEARING. `ps` printed this under `TZ=UTC`; without saying
  // so, `Date.parse` re-reads it in the READER's zone and reintroduces exactly
  // the skew this function exists to remove.
  const parsed = Date.parse(`${rendered} UTC`);
  return Number.isFinite(parsed) ? `${IDENTITY_PREFIX}${Math.floor(parsed / 1000)}` : null;
}

/**
 * Whether two identities can be compared at all, and when not, WHY.
 *
 * EXPORTED SO THE REASON CAN BE ASSERTED, not merely the outcome. Three of these
 * four verdicts produce the same boolean — "do not reclaim" — so a test that
 * checks only the boolean cannot tell a correct migration guard from an
 * implementation that happened to string-match. The legacy case in particular
 * passes at the pre-fix baseline for the WRONG reason: there the reader emitted
 * the same rendered form, so the strings matched and it read as a live holder.
 * After this change it must pass because the two are INCOMPARABLE. Same green,
 * different mechanism — and only this verdict distinguishes them.
 *
 * `stale` REQUIRES POSITIVE CONTRADICTING EVIDENCE. Only `comparable` can lead
 * there; every other verdict is an absence of evidence, and an absence must never
 * become a permission to reclaim. That is the same rule that governs every other
 * safety-relaxing classification in this codebase, arriving at the liveness layer.
 */
export type IdentityComparabilityV1 =
  | "comparable"
  | "no-recorded-identity"
  | "unreadable-now"
  | "unrecognised-format";

/**
 * Classify whether a recorded identity and the current one can be compared.
 *
 * `unrecognised-format` is the MIGRATION GUARD. Every record written before this
 * change holds a rendered date string; a reader emitting `unix:<epoch>` sees a
 * difference, and reading that difference as PID reuse would make the migration
 * cause — on every pre-existing record, immediately — the precise defect it
 * fixes: reclaiming live locks and clearing live fences.
 *
 * @param recorded - The identity the durable record carries, if any.
 * @param current - The identity read for that pid now, or null when unreadable.
 */
export function classifyIdentityComparability(
  recorded: string | undefined, current: string | null,
): IdentityComparabilityV1 {
  if (recorded === undefined) return "no-recorded-identity";
  if (current === null) return "unreadable-now";
  return recorded.startsWith(IDENTITY_PREFIX) && current.startsWith(IDENTITY_PREFIX)
    ? "comparable"
    : "unrecognised-format";
}

/**
 * What the evidence actually says about a recorded owner's process.
 *
 * THE EVIDENCE IS THREE-WAY WHILE THE RECLAMATION DECISION IS BINARY, and
 * collapsing the two together is where the information is lost. `stale` and `live`
 * are both OBSERVATIONS — the process is gone or its PID was reused, versus the
 * process is running under the identity the record names. `unobservable` is
 * neither: the holder is alive but nothing available can say WHICH process it is,
 * so a reused PID and a genuine holder are indistinguishable.
 *
 * {@link isOwnerStale} deliberately maps BOTH unobservable arms to "not stale" —
 * the fail-safe direction, since stealing a lock from a live holder corrupts work
 * while wedging is visible and manually escapable. But a caller that REPORTS
 * liveness to an operator needs the distinction the boolean throws away: "the
 * owner is running" and "we cannot tell whether the owner is running" are
 * opposite things to be told, and only the first justifies waiting.
 *
 * THE UNOBSERVABLE CASE IS SPLIT BY WHETHER IT CAN EVER BECOME OBSERVABLE, which
 * is the only part of it an operator can act on. `unobservable-unreadable` means
 * the evidence EXISTS and this process could not read it — a restricted `ps`, a
 * hardened container, a transient spawn failure — so another host, or another
 * moment, may answer. `unobservable-unrecorded` means the record never stored the
 * evidence at all, and no read can recover what the write declined to store: it
 * is permanent for that record, retrying is futile, and the run needs an operator
 * rather than another attempt. The two are different instructions, and a single
 * `unobservable` told an operator to keep retrying a question that has no answer.
 */
export type OwnerLiveness =
  | "stale" | "live"
  | "unobservable-unreadable" | "unobservable-unrecorded" | "unobservable-unrecognised";

/**
 * Whether a classification is one of the "cannot tell" arms.
 *
 * DERIVED FROM THE NAMING rather than listing the members, so a fourth
 * unobservable arm cannot be added without this answering for it. A hand-written
 * disjunction here is exactly the shape that silently stops covering a new
 * member.
 */
export function isUnobservableLiveness(liveness: OwnerLiveness): boolean {
  return liveness.startsWith("unobservable-");
}

/**
 * Classify a recorded owner against the evidence available right now.
 *
 * A dead PID → `stale`. A live PID whose CURRENT start time differs from the
 * recorded one → `stale` (the PID was reused — the wedge this module exists to
 * close). A live PID with a MATCHING start time → `live`. Everything else is a
 * live PID we cannot identify: a legacy or start-time-less record that never
 * stored the evidence, or a start time that cannot be read now.
 *
 * @param owner - The parsed owner record.
 * @returns What the evidence says, without collapsing "cannot tell" into either answer.
 */
/**
 * Which "cannot tell" arm each incomparable verdict lands on — TOTAL over the
 * non-comparable verdicts, so adding one forces the decision at compile time.
 *
 * `no-recorded-identity` is unreachable here, because the classifier returns on
 * that case before computing a current identity and paying for the probe. It is
 * carried anyway: totality is the point, and an entry that cannot fire costs a
 * line while a missing one costs a silent fall-through to the comparison.
 *
 * THE SPLIT IS PERMANENT-VERSUS-TRANSIENT. `unreadable` may answer from another
 * host or a later moment. `unrecorded` and `unrecognised` never will — the write
 * stored nothing, or stored something this build cannot compare — and no read
 * recovers what the write declined to store.
 */
const UNOBSERVABLE_FOR: Readonly<Record<Exclude<IdentityComparabilityV1, "comparable">, OwnerLiveness>> = {
  "no-recorded-identity": "unobservable-unrecorded",
  "unreadable-now": "unobservable-unreadable",
  "unrecognised-format": "unobservable-unrecognised",
};

export function classifyOwnerLiveness(owner: LockOwner): OwnerLiveness {
  if (!isProcessAlive(owner.pid)) return "stale";
  // PERMANENT FOR THIS RECORD: the write stored no identity, so no later read can
  // recover one. `mintAttemptLease` omits the field whenever the minting host
  // could not read its own start time, so the current build still produces these.
  if (owner.startTime === undefined) return "unobservable-unrecorded";
  // FAST PATH: the record names OUR OWN live process (a concurrent same-process
  // writer holds it). It cannot be a reused PID, so compare against the cached
  // self start time and skip the per-poll `ps` spawn entirely.
  const current = owner.pid === process.pid ? selfStartTime() : readProcessStartTime(owner.pid);
  // NOT COMPARABLE IS UNOBSERVABLE, NEVER A MISMATCH — and WHICH kind of
  // unobservable is what an operator can act on. Routed through a total map so a
  // new comparability verdict cannot reach the comparison below by default: it
  // stops compiling until somebody says which arm it lands on.
  const comparability = classifyIdentityComparability(owner.startTime, current);
  if (comparability !== "comparable") return UNOBSERVABLE_FOR[comparability];
  return current === owner.startTime ? "live" : "stale";
}

/**
 * Decide whether an OWNER record is STALE (its holder no longer holds the lock).
 *
 * DERIVED from {@link classifyOwnerLiveness} rather than re-deriving the evidence,
 * so the reporting surface and the reclamation decision can never disagree about
 * the same record. Only a positive `stale` observation reclaims: `live` respects a
 * genuine holder, and `unobservable` respects it too, trusting the recorded
 * identity rather than stealing a lock on evidence that does not exist.
 *
 * @param owner - The parsed owner record.
 * @returns True when the lock should be treated as stale and reclaimable.
 */
export function isOwnerStale(owner: LockOwner): boolean {
  return classifyOwnerLiveness(owner) === "stale";
}

/**
 * Public lock-file compatibility: old timestamp-only records use the baseline
 * ambient comparison. Strict runtime lease classification remains epoch-only.
 * Existing epoch-in-startTime internal records continue through the strict path.
 */
export function isLockRecordStale(owner: LockOwner): boolean {
  if (owner.identity !== undefined || owner.startTime === undefined || owner.startTime.startsWith(IDENTITY_PREFIX)) {
    return isOwnerStale(owner);
  }
  if (!isProcessAlive(owner.pid)) return true;
  const current = readLegacyProcessStartTime(owner.pid);
  return current !== null && current !== owner.startTime;
}
