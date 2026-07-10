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
 */

import { execFileSync } from "node:child_process";

/** A parsed lock owner: the PID and, when recorded, the holder's process start time. */
export interface LockOwner {
  /** The decimal PID recorded in the leaf. */
  pid: number;
  /** The holder's process start time, when the leaf carried one (new format). */
  startTime?: string;
}

/**
 * This process's OWN start time, read ONCE at module load. Cached because (a) it
 * never changes for the life of the process and (b) the read spawns a synchronous
 * `ps`, which must not run on every lock acquire / poll. `serializeOwner` and the
 * same-process stale short-circuit both reuse this value.
 */
const SELF_START_TIME = readProcessStartTime(process.pid);

/** The serialized owner record written into a FRESH lock leaf (new format). */
export function serializeOwner(pid: number): string {
  const startTime = pid === process.pid ? SELF_START_TIME : readProcessStartTime(pid);
  // Omit startTime when unreadable so a reader never treats "" as a real identity;
  // such a leaf simply degrades to PID-only liveness (best-effort, back-compat).
  return JSON.stringify(startTime === null ? { pid } : { pid, startTime });
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
  if (fromJson !== undefined) return fromJson;
  const pid = parseInt(trimmed, 10);
  return Number.isNaN(pid) ? null : { pid };
}

/** Parse the JSON owner shape; `undefined` when `text` is not a JSON object (try legacy). */
function parseJsonOwner(text: string): LockOwner | null | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const obj = JSON.parse(text) as { pid?: unknown; startTime?: unknown };
    if (typeof obj.pid !== "number" || !Number.isFinite(obj.pid)) return null;
    const startTime = typeof obj.startTime === "string" ? obj.startTime : undefined;
    return { pid: obj.pid, startTime };
  } catch {
    return null;
  }
}

/** Check whether a process with the given PID is still running. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a live PID's process START TIME — a portable, externally-observable boot
 * identity (`ps -o lstart=`). Returns `null` when the PID is gone or `ps` is
 * unavailable/unparseable, so liveness degrades to PID-only rather than failing.
 */
export function readProcessStartTime(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether an OWNER record is STALE (its holder no longer holds the lock).
 *
 * A dead PID → stale (unchanged behavior). A LIVE PID with a recorded start time
 * that DIFFERS from the live process's CURRENT start time → stale (the PID was
 * reused by a new process — the wedge this fix closes). A live PID with a MATCHING
 * (or, for a legacy leaf, ABSENT) start time → NOT stale (a genuine live holder is
 * respected). When the live start time cannot be read, the recorded one is trusted
 * and the holder is respected (best-effort, PID-only fallback).
 *
 * @param owner - The parsed owner record.
 * @returns True when the lock should be treated as stale and reclaimable.
 */
export function isOwnerStale(owner: LockOwner): boolean {
  if (!isProcessAlive(owner.pid)) return true;
  if (owner.startTime === undefined) return false; // legacy leaf → PID-only liveness
  // FAST PATH: the leaf names OUR OWN live process (a concurrent same-process
  // writer holds it). It cannot be a reused PID, so compare against the cached
  // self start time and skip the per-poll `ps` spawn entirely.
  if (owner.pid === process.pid) return SELF_START_TIME !== null && SELF_START_TIME !== owner.startTime;
  const current = readProcessStartTime(owner.pid);
  if (current === null) return false; // unreadable → trust the recorded identity
  return current !== owner.startTime; // mismatch ⇒ PID reused ⇒ stale
}
