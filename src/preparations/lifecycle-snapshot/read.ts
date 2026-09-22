/**
 * @file src/preparations/lifecycle-snapshot/read.ts
 * @description Callback-scoped, root-bound lifecycle read authority. A
 * successful scanner result is process-locally bound to the captured canonical
 * project identity and an active lease; unavailable capture is stable, bounded,
 * and never retried within the callback.
 */

import {
  openPreparationLifecycleNamespace,
  preparationLifecycleRootMatchesBinding,
} from "../lifecycle-fs/namespace.js";
import type { PresentLifecycleDirectoryV1 } from "../lifecycle-fs/types.js";
import { scanPreparationLifecycle } from "./scan.js";
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
): Promise<{ read: PreparationLifecycleReadV1; lease?: ReadLease }> {
  try {
    const namespace = await openPreparationLifecycleNamespace(root, "read");
    const snapshot = await scanPreparationLifecycle(namespace, {
      maxRegistryEntries: options.maxRegistryEntries,
    });
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
