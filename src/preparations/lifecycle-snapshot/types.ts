/**
 * @file src/preparations/lifecycle-snapshot/types.ts
 * @description Public immutable DTOs for one authoritative observation of both
 * preparation lifecycle registries. Raw key bytes and absolute paths are
 * deliberately absent from this surface.
 */

/** Public state of the project preparation-key epoch. */
export type PreparationLifecycleKeyStateV1 =
  | { readonly status: "absent" }
  | { readonly status: "unavailable" }
  | { readonly status: "ok"; readonly keyEpochId: string };

/** The four destructive protocols represented by lifecycle units. */
export type PreparationLifecycleOperationV1 =
  | "per-run-quarantine"
  | "project-key-reset"
  | "run-prune"
  | "orphan-sweep";

/** Closed lifecycle state shared by both physical registries. */
export type PreparationLifecycleUnitStateV1 =
  | "inert"
  | "awaiting-continuation"
  | "planned"
  | "applying"
  | "completed"
  | "historical"
  | "unavailable";

/** Current custody of a completed quarantine/reset unit's retained objects. */
export type CompletedCustodyStateV1 =
  | "verified-retained"
  | "absent-unproven";

/** One stable project-relative scan problem. */
export interface PreparationLifecycleProblemV1 {
  readonly code:
    | "registry-unavailable"
    | "registry-entries-exhausted"
    | "unit-entry-unavailable"
    | "unit-unavailable"
    | "receipt-bytes-exhausted"
    | "object-bytes-exhausted"
    | "postcondition-bytes-exhausted";
  readonly registry: "quarantine" | "prune";
  readonly unitId?: string;
  readonly path: string;
  readonly detail: string;
}

/** Final classification of one physical lifecycle unit. */
export interface PreparationLifecycleUnitV1 {
  readonly registry: "quarantine" | "prune";
  readonly unitId: string;
  readonly operation: PreparationLifecycleOperationV1 | null;
  readonly state: PreparationLifecycleUnitStateV1;
  readonly custody?: CompletedCustodyStateV1;
}

/** Exact physical storage observed beneath one lifecycle registry. */
export interface PreparationLifecycleStorageEntryV1 {
  readonly count: number;
  readonly bytes: number;
  readonly health: "ok" | "unavailable";
  readonly traversalEntries: number;
}

/** Independent physical storage totals for both lifecycle registries. */
export interface PreparationLifecycleStorageV1 {
  readonly quarantine: PreparationLifecycleStorageEntryV1;
  readonly prune: PreparationLifecycleStorageEntryV1;
}

/** One deeply immutable, self-digested lifecycle observation. */
export interface PreparationLifecycleSnapshotV1 {
  readonly namespaceDigest: string;
  readonly keyState: PreparationLifecycleKeyStateV1;
  readonly units: readonly PreparationLifecycleUnitV1[];
  readonly storage: PreparationLifecycleStorageV1;
  readonly complete: boolean;
  readonly problems: readonly PreparationLifecycleProblemV1[];
  readonly digest: string;
}

/** One callback-scoped lifecycle capture or its fail-closed refusal. */
export type PreparationLifecycleReadV1 =
  | {
      readonly status: "ok";
      readonly snapshot: PreparationLifecycleSnapshotV1;
    }
  | {
      readonly status: "unavailable";
      readonly detail: string;
    };

/** Host-owned scanner ceilings. Tests may only tighten these values. */
export interface PreparationLifecycleScanOptionsV1 {
  maxRegistryEntries?: number;
  maxReceiptBytes?: number;
  maxObjectBytes?: number;
  maxPostconditionBytes?: number;
  onRegistryEnumeratedForTest?: (registry: "quarantine" | "prune") => void;
  afterKeyCapturedForTest?: () => Promise<void>;
  afterClassificationForTest?: () => Promise<void>;
}
