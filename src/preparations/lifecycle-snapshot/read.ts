/**
 * @file src/preparations/lifecycle-snapshot/read.ts
 * @description Callback-scoped, root-bound lifecycle read authority. A
 * successful scanner result is process-locally bound to the captured canonical
 * project identity and an active lease; unavailable capture is stable, bounded,
 * and never retried within the callback.
 *
 * ONE CAPTURE PER PASS. {@link withPreparationLifecycleRead} captures once per
 * callback. {@link preparationLifecycleReadPass} captures once per PASS — the
 * legs of one recovery gate, under one hold of the project lock, before any of
 * them writes — and lends that one capture to each leg's callback. The lease is
 * active only while a lent callback runs, exactly as for a single borrow, so a
 * read retained past its callback still fails the proof. Closing the pass ends
 * the sharing: no later borrow is lent the closed pass's read.
 */

import {
  openPreparationLifecycleNamespace,
  preparationLifecycleRootMatchesBinding,
} from "../lifecycle-fs/namespace.js";
import type { PresentLifecycleDirectoryV1 } from "../lifecycle-fs/types.js";
import { lifecycleScanBounds } from "../lifecycle-fs/bounds.js";
import { scanJustOpenedPreparationLifecycle, type LifecycleKeyObservation } from "./scan.js";
import type { PreparationLifecycleReadV1 } from "./types.js";

/**
 * Ceiling applied to one lifecycle read capture. This is NOT a test-only seam:
 * the capacity boundary supplies it so both halves of the shared inventory budget
 * derive from one value. Reference composition captures without it and therefore
 * falls back to the host maximum — identical in production, since that fallback
 * and `preparationScanEntryLimit({})` are the same constant, but it means that
 * path has no test-only tightening seam. Any supplied value is clamped, so it can
 * only tighten.
 */
interface PreparationLifecycleReadOptions {
  maxRegistryEntries?: number;
}

interface ReadLease {
  active: boolean;
}

/** One capture: the read, and its lease when the read is successful. */
interface CapturedRead {
  read: PreparationLifecycleReadV1;
  lease?: ReadLease;
}

interface SuccessfulReadBinding {
  root: PresentLifecycleDirectoryV1;
  lease: ReadLease;
}

const SUCCESSFUL_READS = new WeakMap<object, SuccessfulReadBinding>();
const UNAVAILABLE_DETAIL = "preparation lifecycle capture is unavailable";

/** Typed refusal for forged, cross-root, unavailable, or expired lifecycle reads. */
export class PreparationLifecycleReadError extends Error {
  constructor(
    readonly code: "read-unavailable" | "read-unproven" | "read-root-mismatch" | "read-expired",
    message: string,
  ) {
    super(message);
    this.name = "PreparationLifecycleReadError";
  }
}

/**
 * Capture one successful read or one bounded unavailable value without retry.
 *
 * Both legs are retry-free and both are now pinned by test: the scanner leg by the
 * enumeration count in lifecycle-single-capture.test.ts, and the namespace leg by the
 * opener attempt counter in lifecycle-read-attempts.test.ts. The namespace half was
 * previously unpinned — a retry confined to it survived the whole lease suite, which
 * counts callback invocations rather than opener attempts.
 *
 * The catch is deliberately broad and loses the original error. A defect anywhere in
 * the opener or the scanner therefore reports as one bounded unavailable read, which
 * handoff settlement treats as a silent skip. That is fail-closed but undiagnosable;
 * narrowing it needs its own review round rather than a late unreviewed change.
 */
async function capturePreparationLifecycleRead(
  root: string,
  options: PreparationLifecycleReadOptions,
  keyObservation: LifecycleKeyObservation = "always",
): Promise<CapturedRead> {
  try {
    const namespace = await openPreparationLifecycleNamespace(root, "read");
    // Back to back with the open: its final revalidation is the scan's start proof.
    const snapshot = await scanJustOpenedPreparationLifecycle(namespace, {
      maxRegistryEntries: options.maxRegistryEntries,
    }, keyObservation);
    const read = Object.freeze({ status: "ok" as const, snapshot });
    const lease = { active: true };
    SUCCESSFUL_READS.set(read, { root: namespace.root, lease });
    return { read, lease };
  } catch {
    return {
      read: Object.freeze({ status: "unavailable", detail: UNAVAILABLE_DETAIL }),
    };
  }
}

/**
 * Capture lifecycle authority once, lend it to one callback, and invalidate a
 * successful read in `finally` even when the consumer throws.
 */
export async function withPreparationLifecycleRead<T>(
  root: string,
  consume: (read: PreparationLifecycleReadV1) => Promise<T> | T,
  options: PreparationLifecycleReadOptions = {},
): Promise<T> {
  const captured = await capturePreparationLifecycleRead(root, options);
  try {
    return await consume(captured.read);
  } finally {
    if (captured.lease !== undefined) captured.lease.active = false;
  }
}

/**
 * Lifecycle reads lent to the legs of one pass. `borrow` lends a read for the
 * length of `consume`, as {@link withPreparationLifecycleRead} does; `close` ends
 * the pass, after which no borrow is lent a read captured before it.
 */
export interface PreparationLifecycleReads {
  borrow<T>(
    consume: (read: PreparationLifecycleReadV1) => Promise<T> | T,
    options?: PreparationLifecycleReadOptions,
  ): Promise<T>;
  close(): void;
}

/** A fresh capture for every borrow: {@link withPreparationLifecycleRead} for `root`. */
export function perBorrowLifecycleReads(root: string): PreparationLifecycleReads {
  return {
    borrow: (consume, options) => withPreparationLifecycleRead(root, consume, options),
    close: () => undefined,
  };
}

/** The effective registry-entry ceiling a capture with `options` is taken at. */
function captureCeiling(options: PreparationLifecycleReadOptions): number {
  return lifecycleScanBounds({ maxRegistryEntries: options.maxRegistryEntries }).maxRegistryEntries;
}

/**
 * ONE capture shared by every borrow of one pass over `root`, until `close`.
 *
 * WHAT IS SHARED IS THE CAPTURE, NOT THE LEASE. The lease is active only while
 * at least one lent callback is running, so between borrows the read is expired
 * and a read retained past its callback fails the proof as it always did. A
 * borrow at a different registry-entry ceiling, or after `close`, captures for
 * itself. An unavailable capture is shared like any other: it is never retried
 * within the pass, as it is never retried within one callback.
 *
 * THE SHARED CAPTURE READS THE KEY ONLY FOR UNITS (`"for-units"` in
 * `scan.ts`). The pass's borrowers are the recovery gate's legs, which decide
 * on pending units and quarantine storage and never on the key state, so a
 * project with neither registry has its key left unread. A borrow that does
 * not share the capture reads the key as every other capture does.
 *
 * THE CALLER OWNS THE PASS'S EXTENT: the pass runs under one hold of the
 * project lock, and the caller closes it before the first write or release that
 * could change what was read, so no borrow after that point shares the capture.
 */
export function preparationLifecycleReadPass(root: string): PreparationLifecycleReads {
  const fresh = perBorrowLifecycleReads(root);
  const ceiling = captureCeiling({});
  let shared: Promise<CapturedRead> | undefined;
  let lent = 0;
  let closed = false;
  return {
    async borrow(consume, options = {}) {
      const captured = closed || captureCeiling(options) !== ceiling
        ? undefined : await (shared ??= capturePreparationLifecycleRead(root, {}, "for-units"));
      if (captured === undefined || closed) return fresh.borrow(consume, options);
      lent += 1;
      if (captured.lease !== undefined) captured.lease.active = true;
      try {
        return await consume(captured.read);
      } finally {
        lent -= 1;
        if (captured.lease !== undefined) captured.lease.active = lent > 0;
      }
    },
    close: () => { closed = true; },
  };
}

/** Require a scanner-minted successful read for this root and active callback. */
export async function assertPreparationLifecycleRead(
  root: string,
  read: PreparationLifecycleReadV1,
): Promise<void> {
  if (read.status !== "ok") {
    throw new PreparationLifecycleReadError("read-unavailable", UNAVAILABLE_DETAIL);
  }
  const binding = SUCCESSFUL_READS.get(read);
  if (binding === undefined) {
    throw new PreparationLifecycleReadError("read-unproven", "lifecycle read was not scanner-minted");
  }
  if (!binding.lease.active) {
    throw new PreparationLifecycleReadError("read-expired", "lifecycle read lease has expired");
  }
  const sameRoot = await preparationLifecycleRootMatchesBinding(root, binding.root);
  // UNCONTROLLED BUT LOAD-BEARING. This second check closes the window where the
  // lease expires DURING the await above; the first check cannot see it. Removing
  // it leaves the suite green because reaching that window needs a floating
  // callback. Do not remove it as duplicated logic — it is not.
  if (!binding.lease.active) {
    throw new PreparationLifecycleReadError("read-expired", "lifecycle read lease has expired");
  }
  if (!sameRoot) {
    throw new PreparationLifecycleReadError(
      "read-root-mismatch", "lifecycle read belongs to another project root",
    );
  }
}

export type { PreparationLifecycleReadV1 } from "./types.js";
