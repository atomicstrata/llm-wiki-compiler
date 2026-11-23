/**
 * @file src/portable/store/disk-store.ts
 * @description A portable project stored in an ordinary project directory.
 *
 * It keeps today's layout and reuses today's safety primitives: confined,
 * handle-bound reads; the project mutation lock as its sequencer; the shared
 * page-apply primitive for page bytes. What it adds is its own publication
 * ledger and its own recovery owner (see `disk-intent.ts`).
 *
 * It is honest about a plain directory. Editors, sync tools and `git` do not
 * take the lock, so it declares `externalWriters: "possible"` and promises
 * detection and no silent overwrite in recovery, not snapshot isolation.
 */

import { realpath } from "node:fs/promises";
import { acquireMutationLockBlocking, RecoveryGateError } from "../../operation-bundles/lock-gate.js";
import { ScaleGateError } from "../../scale/gate.js";
import { LockBusyError, releaseLock } from "../../utils/lock.js";
import { GENERATED_PAGE_MAX_CHARS } from "../../utils/constants.js";
import type {
  AdapterCapabilitiesV1,
  ContentDigest,
  LabelSet,
  ObservedObject,
  OperationIdentityRecordV1,
  ReceiptV1,
  ResolutionRecordV1,
  TargetObservation,
} from "../contracts.js";
import { PortableRefusal } from "../errors.js";
import { APPROVALS_PREFIX, PROPOSALS_PREFIX } from "../logical-paths.js";
import {
  createDurableRecord,
  listFileNames,
  listFilesRecursive,
  readJsonRecord,
  observeProjectFile,
  readProjectFile,
  writeProjectFile,
  writeProjectFileDurable,
} from "./disk-io.js";
import { isReplacingRecordTemp } from "./disk-record-entries.js";
import { bytesDigest } from "../digest.js";
import { ledgerDir, ledgerFile, ledgerKey, relativeDirFor, relativeFileFor } from "./disk-layout.js";
import { completeCommittedLabels } from "./disk-completion.js";
import { unresolvedDiskIntents } from "./disk-intent.js";
import { publishToDisk } from "./disk-publish.js";
import { abandonDiskIntent, observeDiskIntent, recoverDiskIntents, rollBackDiskIntent } from "./disk-recovery.js";
import {
  holdsNoCustody, isIdentityRecord, ledgerBlocked, readOpenMarkers, removeOpenMarker, writeOpenMarker, type OpenMarker,
} from "./disk-open-operations.js";
import type { RegistrationMode } from "../host/control.js";
import type {
  IntentClosure,
  IntentObservation,
  ProjectStore,
  PublishBatch,
  PublishFaultStage,
  ReadView,
  RecoveryResult,
} from "./store.js";

/** D23: provisional cap on one J1 object and on the pre-images of one operation. */
const MAX_OBJECT_BYTES = 1024 * 1024;
const MAX_PREIMAGE_BYTES = 8 * MAX_OBJECT_BYTES;

/** Ledger records are small; this bounds a damaged or planted one. */
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

const DISK_CAPABILITIES: AdapterCapabilitiesV1 = {
  conditionalWrite: "per-object-cas",
  batchPublish: "journalled-cooperative",
  receiptCustody: "journalled-cooperative",
  snapshotRead: "none",
  historyRetention: { retained: "none" },
  projectRevision: "none",
  listConsistency: "validate-digest",
  durability: "crash-consistent",
  externalWriters: "possible",
  // A page may be larger in bytes than in characters; the stricter of the two caps wins.
  limits: {
    maxObjectBytes: Math.min(MAX_OBJECT_BYTES, GENERATED_PAGE_MAX_CHARS * 4),
    maxPreimageBytes: MAX_PREIMAGE_BYTES,
    maxListPage: 1000,
  },
};

/** How the store is opened: the registration it reads at every gated step, and test seams. */
export interface DiskStoreOptions {
  faultForTest?: (stage: PublishFaultStage) => void;
  /**
   * The project's CURRENT registration mode, read again at every gated step so
   * a session opened before an adoption never keeps a stale format. Omitted,
   * the store behaves as format 1, exactly as before.
   */
  registration?: () => Promise<RegistrationMode>;
}

/** What the disk store's helpers need to know about it. */
export interface DiskStoreContext {
  root: string;
  projectId: string;
  maxObjectBytes: number;
  maxPreimageBytes: number;
  maxRecordBytes: number;
  faultForTest?: (stage: PublishFaultStage) => void;
}

/** A portable project over a local project directory. */
export class DiskProjectStore implements ProjectStore {
  readonly capabilities = DISK_CAPABILITIES;
  private readonly context: DiskStoreContext;
  private readonly registration: () => Promise<RegistrationMode>;

  private constructor(readonly projectId: string, readonly root: string, options: DiskStoreOptions) {
    this.registration = options.registration ?? (async () => "format-1");
    this.context = {
      root, projectId, maxObjectBytes: MAX_OBJECT_BYTES, maxPreimageBytes: MAX_PREIMAGE_BYTES,
      maxRecordBytes: MAX_RECORD_BYTES, faultForTest: options.faultForTest,
    };
  }

  /** Open the store for a registered project root. */
  static async open(projectId: string, root: string, options: DiskStoreOptions = {}): Promise<DiskProjectStore> {
    return new DiskProjectStore(projectId, await realpath(root), options);
  }

  /**
   * Hold the project mutation lock, the same one every legacy mutation takes,
   * so portable and legacy work never interleave. Legacy journal recovery runs
   * first inside the gate; that is safe because it owns none of our writes.
   */
  async withGate<T>(fn: () => Promise<T>): Promise<T> {
    return this.gated(async () => {
      await completeCommittedLabels(this.context);
      return fn();
    });
  }

  /**
   * The gate for an authorized STATUS read only. It completes interrupted
   * commits exactly as {@link withGate} does, but when that cannot be proved it
   * still runs `fn`, told that no recovery may run: the receipt alone then
   * answers, so the recorded commit is reported truthfully while every content
   * read and every other gated step refuses.
   */
  async withStatusGate<T>(fn: (mayRecover: boolean) => Promise<T>): Promise<T> {
    return this.gated(async () => {
      const isComplete = await completeCommittedLabels(this.context).then(() => true, (error: unknown) => {
        if (error instanceof PortableRefusal) return false;
        throw error;
      });
      return fn(isComplete);
    });
  }

  /**
   * Hold the project mutation lock and check the registration, then run `fn`.
   * Before `fn`, the gates above finish any commit whose label bindings a
   * crash interrupted. That is HOST-OWNED: it completes an operation already
   * committed under its own authorization, creates no operation, consumes no
   * approval and writes no target byte, so it runs for whoever reaches the
   * gate, before that caller's own entitlement is checked. A caller-requested
   * recovery (`operationStatus`, `resolve`) still triggers nothing until its
   * caller is authorized. When completion cannot be proved, `withGate` refuses
   * `recovery_blocking`: no read, write, recovery or new operation proceeds.
   */
  private async gated<T>(fn: () => Promise<T>): Promise<T> {
    try {
      await acquireMutationLockBlocking(this.root, "portable");
    } catch (error) {
      if (error instanceof RecoveryGateError) throw new PortableRefusal("recovery_blocking", error.code);
      // An unfinished, parked or unavailable expected-scale transition blocks every portable step the same way.
      if (error instanceof ScaleGateError) throw new PortableRefusal("recovery_blocking", error.block);
      throw error;
    }
    try {
      // An adoption part-way through, or a registration this binary cannot honour, admits no portable step at all.
      const mode = await this.registration();
      if (mode !== "format-1" && mode !== "format-2") throw new PortableRefusal("capability_unsupported", `registration is ${mode}`);
      return await fn();
    } finally {
      await releaseLock(this.root);
    }
  }

  /** The registration mode right now. */
  registrationMode(): Promise<RegistrationMode> {
    return this.registration();
  }

  /** Version 1 proposals and applies are refused by name on an adopted (format-2) project. */
  async formatRefusesV1(): Promise<boolean> {
    return (await this.registration()) !== "format-1";
  }

  /** A directory cannot be pinned (`snapshotRead: "none"`), so generation reads live and is validated later. */
  async generationView(): Promise<ReadView> {
    return this;
  }

  /**
   * Hold the cooperating gate for the whole read. Checking for an unresolved
   * intent before and after without the lock would let an entire publication
   * land in between; under the lock no cooperating writer can.
   */
  async withReadView<T>(fn: (view: ReadView) => Promise<T>): Promise<T> {
    try {
      return await this.withGate(async () => {
        if ((await this.unresolvedIntents()).length > 0) throw new PortableRefusal("publication_in_progress");
        return fn(this);
      });
    } catch (error) {
      if (error instanceof LockBusyError) throw new PortableRefusal("publication_in_progress", "project busy");
      throw error;
    }
  }

  async read(path: string): Promise<Uint8Array | null> {
    return readProjectFile(this.root, relativeFileFor(path), MAX_OBJECT_BYTES);
  }

  /**
   * The disk revision is the stat fingerprint PLUS the content digest (D22). It
   * is honest about its limits: the fingerprint can change without the content
   * changing, and a digest alone cannot see an ABA replacement. Neither half is
   * ever dropped to make a comparison easier.
   */
  async observe(path: string): Promise<ObservedObject | null> {
    const seen = await observeProjectFile(this.root, relativeFileFor(path), MAX_OBJECT_BYTES);
    if (seen === null) return null;
    const digest = bytesDigest(seen.bytes);
    return { bytes: seen.bytes, digest, revision: `${seen.fingerprint}:${digest}` };
  }

  /** Records are listed recursively; curated namespaces one level deep, as the layout is. */
  async list(prefix: string): Promise<string[]> {
    const dir = relativeDirFor(prefix);
    const isRecord = prefix.startsWith(PROPOSALS_PREFIX) || prefix.startsWith(APPROVALS_PREFIX);
    const names = isRecord ? await listFilesRecursive(this.root, dir) : await listFileNames(this.root, dir);
    return names.map((name) => `${prefix}${name}`);
  }

  async labelsFor(path: string, digest: ContentDigest): Promise<LabelSet | null> {
    const record = await readJsonRecord<{ digest: string; labels: string[] }>(
      this.root, ledgerFile("labels", ledgerKey(path)), MAX_RECORD_BYTES,
    );
    return record && record.digest === digest ? record.labels : null;
  }

  /**
   * The labels of the LATEST binding of `path`, whatever bytes it bound, or
   * `null` when it was never bound. A path rewritten outside the portable path
   * keeps no binding for its new bytes; this is what a reconciliation must
   * never bind them below.
   */
  async lastLabels(path: string): Promise<LabelSet | null> {
    const bytes = await readProjectFile(this.root, ledgerFile("labels", ledgerKey(path)), MAX_RECORD_BYTES);
    if (bytes === null) return null;
    let labels: unknown;
    try {
      labels = (JSON.parse(bytes.toString("utf8")) as { labels?: unknown } | null)?.labels;
    } catch {
      labels = undefined;
    }
    const isLabelSet = Array.isArray(labels) && labels.every((label) => typeof label === "string");
    // A damaged binding could hide a stricter classification: never read it as "never bound".
    if (!isLabelSet) throw new PortableRefusal("recovery_blocking", `label record malformed: ${path}`);
    return labels as LabelSet;
  }

  /** On format 2, the latest binding of `path`: the floor of every new binding. A format-1 directory keeps none. */
  async retainedLabels(path: string): Promise<LabelSet> {
    if ((await this.registration()) !== "format-2") return [];
    return (await this.lastLabels(path)) ?? [];
  }

  async reconcileLabels(path: string, digest: ContentDigest, labels: LabelSet): Promise<void> {
    const record = { path, digest, labels, by: "reconciled", at: new Date().toISOString() };
    await writeProjectFile(this.root, ledgerFile("labels", ledgerKey(path)), JSON.stringify(record));
  }

  async getIdentity(operationId: string): Promise<OperationIdentityRecordV1 | null> {
    const record = await readJsonRecord<OperationIdentityRecordV1>(
      this.root, ledgerFile("identity", operationId), MAX_RECORD_BYTES,
    );
    // A ledger carried in by a copy belongs to another identity and is never honoured.
    return record && record.project === this.projectId ? record : null;
  }

  /**
   * Write an identity record, DURABLY (file and directory chain synced). On
   * format 2 the open-operation marker is kept in step: durably written BEFORE
   * an in-progress record, removed (non-durably) AFTER a terminal one, each
   * step awaited. A sync failure throws before the next step, so a caller's
   * resolve, generation or publish never runs on an identity that may not
   * persist; the receipt and the durable close stay decisive either way.
   */
  async putIdentity(record: OperationIdentityRecordV1): Promise<void> {
    const isFormat2 = (await this.registration()) === "format-2";
    const isOpen = record.outcome === "in-progress";
    if (isFormat2 && isOpen) await writeOpenMarker(this.root, record);
    await writeProjectFileDurable(this.root, ledgerFile("identity", record.operationId), JSON.stringify(record));
    if (isFormat2 && !isOpen) await removeOpenMarker(this.root, record.operationId);
  }

  /** Open operations: from the maintained markers on format 2, by the historical scan on format 1. */
  async listOpenOperations(): Promise<string[]> {
    return (await this.registration()) === "format-2" ? this.openFromMarkers() : this.openFromIdentityScan();
  }

  /**
   * Read the markers, settling what they say against the identity records:
   * a terminal identity drops its stale marker; a missing one is restored
   * from its marker only when that loses nothing (see {@link restoreFromMarker}).
   * A malformed marker or an unreadable or malformed identity refuses.
   */
  private async openFromMarkers(): Promise<string[]> {
    const open: string[] = [];
    for (const marker of await readOpenMarkers(this.root, this.projectId)) {
      const identity = await this.checkedIdentity(marker.operationId);
      if (identity === null) await this.restoreFromMarker(marker);
      else if (identity.outcome !== "in-progress") {
        await removeOpenMarker(this.root, marker.operationId);
        continue;
      }
      open.push(marker.operationId);
    }
    return open;
  }

  /** An identity record that must be readable and complete if present: anything else refuses. */
  private async checkedIdentity(operationId: string): Promise<OperationIdentityRecordV1 | null> {
    const record = await this.getIdentity(operationId).catch(() => {
      throw ledgerBlocked(`identity record unreadable: ${operationId}`);
    });
    if (record !== null && !isIdentityRecord(record)) throw ledgerBlocked(`identity record malformed: ${operationId}`);
    return record;
  }

  /**
   * Restore a missing identity from its marker — ONLY when the receipt or the
   * durable close is there to decide it, or the record held no custody that
   * its loss could release. Otherwise refuse until an operator restores it.
   * The restored record is written durably; nothing is synthesized from a
   * receipt or a closure.
   */
  private async restoreFromMarker(marker: OpenMarker): Promise<void> {
    const { operationId } = marker;
    const isSettledElsewhere = (await this.getReceipt(operationId)) !== null || (await this.getClosure(operationId)) !== null;
    if (!isSettledElsewhere && !holdsNoCustody(marker.record)) {
      throw ledgerBlocked(`identity record of ${operationId} is missing and its marker holds custody; restore ${ledgerFile("identity", operationId)} from a backup before any further write`);
    }
    await writeProjectFileDurable(this.root, ledgerFile("identity", operationId), JSON.stringify(marker.record));
  }

  /**
   * Format 1: every identity record the project has. Proportional to its whole
   * history. The replacing writer's exact temp sibling is skipped BEFORE an id
   * is derived from its name (a maximum-length safe id plus that suffix would
   * otherwise manufacture an unsafe key); every other name behaves as before.
   */
  private async openFromIdentityScan(): Promise<string[]> {
    const open: string[] = [];
    for (const name of await listFileNames(this.root, ledgerDir("identity"))) {
      // `listFileNames` lists regular files only.
      if (isReplacingRecordTemp({ name, regular: true })) continue;
      const operationId = name.replace(/\.json$/u, "");
      if ((await this.getIdentity(operationId))?.outcome === "in-progress") open.push(operationId);
    }
    return open;
  }

  async getReceipt(operationId: string): Promise<ReceiptV1 | null> {
    const receipt = await readJsonRecord<ReceiptV1>(this.root, ledgerFile("receipts", operationId), MAX_RECORD_BYTES);
    return receipt && receipt.project === this.projectId ? receipt : null;
  }

  async getReservation(key: string): Promise<string | null> {
    const record = await readJsonRecord<{ by: string }>(
      this.root, ledgerFile("reservations", ledgerKey(key)), MAX_RECORD_BYTES,
    );
    return record?.by ?? null;
  }

  /**
   * Record that `operationId` holds `key` (an approval or ticket), DURABLY,
   * before the holder's identity records the hold: custody reads the
   * reservation first, so it must not be lost while the hold survives.
   */
  async putReservation(key: string, operationId: string): Promise<void> {
    const record = JSON.stringify({ key, by: operationId });
    await writeProjectFileDurable(this.root, ledgerFile("reservations", ledgerKey(key)), record);
  }

  publish(batch: PublishBatch): Promise<void> {
    return publishToDisk(this.context, batch);
  }

  async unresolvedIntents(): Promise<string[]> {
    return unresolvedDiskIntents(this.root);
  }

  recover(): Promise<RecoveryResult[]> {
    return recoverDiskIntents(this.context);
  }

  observeIntent(operationId: string): Promise<IntentObservation | null> {
    return observeDiskIntent(this.context, operationId);
  }

  rollBackIntent(operationId: string, confirmed: readonly TargetObservation[]): Promise<void> {
    return rollBackDiskIntent(this.context, operationId, confirmed);
  }

  abandonIntent(operationId: string, resolution: ResolutionRecordV1): Promise<void> {
    return abandonDiskIntent(this.context, operationId, resolution);
  }

  getClosure(operationId: string): Promise<IntentClosure | null> {
    return readJsonRecord<IntentClosure>(this.root, ledgerFile("closed", operationId), MAX_RECORD_BYTES);
  }
}
