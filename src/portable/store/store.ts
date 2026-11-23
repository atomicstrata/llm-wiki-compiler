/**
 * @file src/portable/store/store.ts
 * @description The internal storage SPI a host publishes a project through.
 *
 * A {@link ProjectStore} holds one project's objects and its operation ledger.
 * It knows bytes, logical paths and how to make one batch of writes durable
 * with its receipt — and it declares, in its capabilities, exactly what that
 * means on its backend. It decides nothing about who may do what: every caller
 * is the publication authority or the logical project above it. It is never a
 * network interface.
 *
 * The publication protocol differs by backend, so it lives behind
 * {@link ProjectStore.publish}: a manifest store swaps one head and has nothing
 * to recover; a journalled store writes an intent first and may leave one for
 * {@link ProjectStore.recover} to settle.
 */

import type {
  AdapterCapabilitiesV1,
  ContentDigest,
  LabelSet,
  ObjectImage,
  ObservedObject,
  OperationIdentityRecordV1,
  OperationKind,
  ReceiptV1,
  RecoveryDetail,
  ResolutionRecordV1,
  TargetObservation,
} from "../contracts.js";

/** One object a publication writes, with the state it must replace. */
export interface StoredWrite {
  path: string;
  bytes: Uint8Array;
  /** What the target must be before the write. Record batches are always `absent`. */
  pre: ObjectImage;
  labels: LabelSet;
}

/** A derived object written with a publication but never doubted because of it. */
export interface TailWrite { path: string; bytes: Uint8Array; labels: LabelSet }

/** Everything one publication makes visible. */
export interface PublishBatch {
  operationId: string;
  kind: OperationKind;
  writes: readonly StoredWrite[];
  /** The complete commit record, written with the bytes it describes. */
  receipt: ReceiptV1;
  tail: readonly TailWrite[];
}

/** What recovery decided for one intent that had no commit receipt. */
export type RecoveryResult =
  | { operationId: string; result: "rolled-forward"; receipt: ReceiptV1 }
  | { operationId: string; result: "no-effect"; detail: RecoveryDetail }
  | { operationId: string; result: "parked" };

/** How an intent that did not commit was durably closed. */
export type IntentClosure =
  | { outcome: "refused"; detail: RecoveryDetail }
  | { outcome: "abandoned"; resolution: ResolutionRecordV1 };

/**
 * The exact current state of one target, taken from the same bounded confined
 * read that classified it: its content digest, its absence, or `unverifiable`
 * when the bytes could not be read within that read (unreadable, over the cap,
 * or replaced mid-read). INTERNAL evidence for comparing two observations; it
 * is never recorded, returned or sent.
 */
export type TargetEvidence =
  | { state: "present"; digest: ContentDigest }
  | { state: "absent" }
  | { state: "unverifiable" };

/**
 * Thrown by {@link ProjectStore.rollBackIntent} when the rollback's OWN
 * observation of the whole target set differs from the set the caller decided
 * on (a target at neither image, or a changed pre/post class). Nothing was written and nothing was closed;
 * the intent stays parked. Internal: the resolver reports it as the existing
 * `targets_changed` outcome. It is distinct from a pre-image that cannot be
 * restored, which stays `preimage_unavailable`.
 */
export class IntentTargetsChangedError extends Error {
  constructor(operationId: string) {
    super(`the targets of ${operationId} changed before its rollback; nothing was written`);
    this.name = "IntentTargetsChangedError";
  }
}

/** What a parked intent's targets look like right now. */
export interface IntentObservation {
  operationId: string;
  targets: readonly TargetObservation[];
  /** Per target, in `targets` order: the exact state behind each class. Internal; see {@link TargetEvidence}. */
  evidence: readonly TargetEvidence[];
  /** Whether every retained pre-image is present and matches its digest. */
  preimagesVerify: boolean;
}

/**
 * A point in the publication protocol a test can interrupt: after the intent,
 * after the started marker, after EACH target write (so a test can stop after
 * a prefix), after all writes, after the receipt, and after the label
 * bindings but before the intent is removed; and, in a rollback of a parked
 * intent, just before the rollback's own observation of the whole target set
 * (`before-rollback-observation`). Internal test seam only.
 */
export type PublishFaultStage =
  | "after-intent" | "after-started" | "after-target" | "after-writes" | "after-receipt" | "after-labels" | "before-rollback-observation";

/**
 * What a reader may ask of a project: objects, listings, the labels bound to
 * exact bytes, and commit receipts. A {@link ProjectStore} is itself a live
 * view; {@link ProjectStore.generationView} and {@link ProjectStore.withReadView}
 * hand out the views a generation or a served read must use instead.
 */
export interface ReadView {
  /** One object's bytes, or `null` when it does not exist. */
  read(path: string): Promise<Uint8Array | null>;
  /**
   * One object with the version it was observed at, or `null` when absent.
   * The revision is this adapter's own token and only it interprets it.
   */
  observe(path: string): Promise<ObservedObject | null>;
  /** Every object path under `prefix`, sorted. */
  list(prefix: string): Promise<string[]>;
  /** The committed labels bound to exactly this (path, digest), or `null`. */
  labelsFor(path: string, digest: ContentDigest): Promise<LabelSet | null>;
  /** The commit receipt of one operation, or `null`. */
  getReceipt(operationId: string): Promise<ReceiptV1 | null>;
}

/** One project's objects and ledger on one backend. */
export interface ProjectStore extends ReadView {
  readonly projectId: string;
  readonly capabilities: AdapterCapabilitiesV1;

  /** Run `fn` as the project's single publication authority. Serializes all callers. */
  withGate<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * OPTIONAL. The gate for an authorized status read, for a store whose
   * {@link withGate} can refuse every step while metadata it must complete
   * cannot be proved: `fn` still runs, told whether recovery may run, so the
   * recorded outcome can be reported. Absent, status uses {@link withGate}.
   */
  withStatusGate?<T>(fn: (mayRecover: boolean) => Promise<T>): Promise<T>;

  /**
   * The view a generation reads through while it runs OUTSIDE the gate. An
   * adapter that declares `snapshotRead: "head-consistent"` returns an
   * immutable view pinned to one head; an adapter without snapshots returns a
   * live view and says so in its capabilities. Either way the final dependency
   * validation compares against the current head, never against this view.
   */
  generationView(): Promise<ReadView>;

  /**
   * Run one served read against a consistent view. A manifest store pins a
   * head. A disk store holds the cooperating gate for the whole read, so an
   * entire publication cannot land in the middle of it, and refuses with
   * `publication_in_progress` while any intent is unresolved.
   */
  withReadView<T>(fn: (view: ReadView) => Promise<T>): Promise<T>;

  /** Bind host-assigned labels to bytes that were written outside the portable path. */
  reconcileLabels(path: string, digest: ContentDigest, labels: LabelSet): Promise<void>;

  getIdentity(operationId: string): Promise<OperationIdentityRecordV1 | null>;
  putIdentity(record: OperationIdentityRecordV1): Promise<void>;
  /** Ids of operations whose identity record is still in progress. */
  listOpenOperations(): Promise<string[]>;

  /** The operation currently holding `key` (an approval or ticket id), if any. */
  getReservation(key: string): Promise<string | null>;
  putReservation(key: string, operationId: string): Promise<void>;

  /**
   * Make one batch visible with its receipt, by this backend's declared
   * protocol. Throws {@link import("../errors.js").PortableRefusal} when it
   * refuses before any write; any other throw means the outcome is unknown.
   */
  publish(batch: PublishBatch): Promise<void>;

  /** Ids of intents with no recorded terminal outcome. */
  unresolvedIntents(): Promise<string[]>;
  /** Settle every decidable intent; leave the rest parked. */
  recover(): Promise<RecoveryResult[]>;
  /** Re-observe a parked intent's targets. `null` when the id is not parked. */
  observeIntent(operationId: string): Promise<IntentObservation | null>;
  /**
   * Revert exactly the targets still at their post-image, then close the intent.
   * `confirmed` is the ordered `{ path, observed }` set the caller decided on.
   * Throws {@link IntentTargetsChangedError}, writing and closing nothing, when its
   * own observation differs from it (a changed class, or a target at neither image).
   */
  rollBackIntent(operationId: string, confirmed: readonly TargetObservation[]): Promise<void>;
  /** Leave every target as it is and close the intent with its resolution. */
  abandonIntent(operationId: string, resolution: ResolutionRecordV1): Promise<void>;

  /**
   * The durable terminal close of an intent that did NOT commit, or `null`.
   * It is written before any identity record is updated, so it — not the
   * identity record — is what says an operation was refused by recovery or
   * abandoned by an operator. A crash between the two must not lose it.
   */
  getClosure(operationId: string): Promise<IntentClosure | null>;

  /**
   * True when this store's project has adopted a format whose state custody
   * version 1 proposals and applies would bypass (S2b). Absent means false:
   * every store but an adopted registered directory accepts version 1 writes.
   */
  formatRefusesV1?(): Promise<boolean>;

  /**
   * The labels no new binding of `path` may drop below: its latest binding,
   * whatever bytes it bound (S2b). Absent, or empty, means no floor: every
   * store but an adopted registered directory has none, so its behaviour is unchanged.
   */
  retainedLabels?(path: string): Promise<LabelSet>;
}

/** The capability a publication needs that `store` lacks, if any (D20). */
export function missingPublicationCapability(store: ProjectStore, writeCount: number): string | null {
  const caps = store.capabilities;
  if (caps.receiptCustody === "none") return "receiptCustody";
  if (caps.conditionalWrite !== "per-object-cas") return "conditionalWrite";
  if (writeCount > 1 && caps.batchPublish === "none") return "batchPublish";
  return null;
}
