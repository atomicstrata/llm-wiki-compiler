/**
 * @file src/preparations/lifecycle-fs/types.ts
 * @description Immutable authority types for the root-anchored preparation
 * lifecycle namespace. Present directories carry their canonical identity;
 * absent directories carry only the exact lexical child that was proved
 * absent beneath a present parent.
 */

/** How a lifecycle namespace may interact with absent owned directories. */
export type PreparationLifecycleNamespaceMode = "read" | "mutate";

/** One real directory captured by canonical path and filesystem identity. */
export interface PresentLifecycleDirectoryV1 {
  readonly status: "present";
  readonly lexicalPath: string;
  readonly realPath: string;
  readonly dev: number;
  readonly ino: number;
}

/** One exact child proved absent beneath a bound parent. */
export interface AbsentLifecycleDirectoryV1 {
  readonly status: "absent";
  readonly lexicalPath: string;
}

/** A present or proved-absent lifecycle-owned directory. */
export type BoundLifecycleDirectoryV1 =
  | PresentLifecycleDirectoryV1
  | AbsentLifecycleDirectoryV1;

/** One exact child that exists but could not be bound as a lifecycle directory. */
export interface UnboundLifecycleDirectoryV1 {
  readonly status: "unavailable";
  readonly lexicalPath: string;
  readonly detail: string;
}

/**
 * A registry binding that may additionally have failed to bind.
 *
 * Only the PRUNE registry widens this far, and only in read mode. Quarantine
 * totals gate key-epoch compatibility, so a quarantine binding fault must reject
 * the whole capture; prune is outside those totals and never entered capacity's
 * problems, so binding the two together made a prune-root fault block unrelated
 * staging. Consumers that genuinely need prune read the resulting unavailable
 * storage health and stay fail-closed.
 */
export type BoundLifecycleRegistryV1 =
  | BoundLifecycleDirectoryV1
  | UnboundLifecycleDirectoryV1;

/** One exact key leaf captured without reading or surfacing its bytes. */
export interface PresentLifecycleKeyLeafV1 {
  readonly status: "present";
  readonly lexicalPath: string;
  readonly kind: "regular" | "other";
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
}

/** A present or proved-absent preparation key leaf. */
export type BoundLifecycleKeyLeafV1 =
  | PresentLifecycleKeyLeafV1
  | AbsentLifecycleDirectoryV1;

/** Root-bound authority over both physical lifecycle registries. */
export interface PreparationLifecycleNamespaceV1 {
  readonly mode: PreparationLifecycleNamespaceMode;
  readonly root: PresentLifecycleDirectoryV1;
  readonly privateRoot: BoundLifecycleDirectoryV1;
  readonly quarantineRegistry: BoundLifecycleDirectoryV1;
  readonly pruneRegistry: BoundLifecycleRegistryV1;
  readonly preparationKey: BoundLifecycleKeyLeafV1;
  readonly digest: string;
}

/** Same-UID directory mutation facts that do not require re-enumeration. */
export interface LifecycleDirectoryVersionObservation {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

/** One closed directory inventory captured under a specific inode. */
export interface LifecycleDirectoryObservation {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly names: readonly string[];
  readonly version?: LifecycleDirectoryVersionObservation;
}

/** One regular lifecycle path opened through the confined read seam. */
export interface LifecycleStorageFileObservation {
  readonly path: string;
  readonly lexicalPath: string;
  readonly parentPath: string;
  readonly bytes: number;
  readonly dev: number;
  readonly ino: number;
}

/** Mutable-during-capture facts published as one closed registry observation. */
export interface LifecycleRegistryStorageObservation {
  readonly files: readonly LifecycleStorageFileObservation[];
  readonly directories: readonly LifecycleDirectoryObservation[];
  readonly traversalEntries: number;
  readonly complete: boolean;
}

/** Mutable low-level storage facts retained only during one registry capture. */
export interface LifecycleStorageCapture {
  files: LifecycleStorageFileObservation[];
  directories: LifecycleDirectoryObservation[];
  handledPaths: Set<string>;
  traversalEntries: number;
  complete: boolean;
  exhausted: boolean;
}

/** Optional recognized child inventory that storage must not list again. */
export interface ReusedLifecycleDirectory {
  path: string;
  observation: LifecycleUnitObservation["bytes"];
}

/** One registry's semantic observations plus independent storage facts. */
export interface LifecycleRegistryObservation {
  units: LifecycleUnitObservation[];
  problems: LifecycleObservationProblem[];
  storage: LifecycleRegistryStorageObservation;
}

/** Stable low-level observation problem projected by the snapshot layer. */
export interface LifecycleObservationProblem {
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

/** Raw observation of one quarantine or prune unit. */
export interface LifecycleUnitObservation {
  readonly registry: "quarantine" | "prune";
  readonly unitId: string;
  readonly unitRoot: string;
  readonly directory?: LifecycleDirectoryObservation;
  readonly bytes?: LifecycleDirectoryObservation | { readonly status: "absent"; readonly path: string };
  readonly problem?: LifecycleObservationProblem;
}

/** Both registries observed once, without record interpretation. */
export interface LifecycleObservationSet {
  readonly units: readonly LifecycleUnitObservation[];
  readonly problems: readonly LifecycleObservationProblem[];
  readonly storage: {
    readonly quarantine: LifecycleRegistryStorageObservation;
    readonly prune: LifecycleRegistryStorageObservation;
  };
}
