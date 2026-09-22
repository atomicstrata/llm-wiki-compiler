/**
 * @file src/preparations/lifecycle-fs/bounds.ts
 * @description Host-owned lifecycle scan ceilings and monotonic test-only
 * tightening. Callers cannot raise any production limit.
 */

import {
  MAX_ACTIVE_PREPARATION_BYTES,
  MAX_PREPARATION_INVENTORY_ENTRIES,
  MAX_PREPARATION_EVIDENCE_OBJECT_BYTES,
} from "../constants.js";
import { MAX_LIFECYCLE_RECEIPT_BYTES } from "../receipts.js";

/** Scanner inputs relevant to bound tightening, independent of snapshot DTOs. */
interface LifecycleScanBoundsInput {
  maxRegistryEntries?: number;
  maxReceiptBytes?: number;
  maxObjectBytes?: number;
  maxPostconditionBytes?: number;
}

/** Effective closed bounds plus mutable aggregate counters private to one scan. */
export interface LifecycleScanBounds {
  readonly maxRegistryEntries: number;
  readonly maxReceiptBytes: number;
  readonly maxObjectBytes: number;
  readonly maxPostconditionBytes: number;
  registryEntries: number;
  postconditionBytes: number;
}

/** Tighten one host ceiling without accepting invalid or larger caller input. */
function tightened(value: number | undefined, hostMaximum: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? Math.min(value as number, hostMaximum)
    : hostMaximum;
}

/** Construct one scan's effective ceilings and zeroed counters. */
export function lifecycleScanBounds(
  options: LifecycleScanBoundsInput,
): LifecycleScanBounds {
  return {
    maxRegistryEntries: tightened(
      options.maxRegistryEntries,
      MAX_PREPARATION_INVENTORY_ENTRIES,
    ),
    maxReceiptBytes: tightened(options.maxReceiptBytes, MAX_LIFECYCLE_RECEIPT_BYTES),
    maxObjectBytes: tightened(options.maxObjectBytes, MAX_PREPARATION_EVIDENCE_OBJECT_BYTES),
    maxPostconditionBytes: tightened(
      options.maxPostconditionBytes,
      MAX_ACTIVE_PREPARATION_BYTES,
    ),
    registryEntries: 0,
    postconditionBytes: 0,
  };
}
