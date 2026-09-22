/**
 * @file test/preparations/lifecycle-model/module-ownership.ts
 * @description The closed classification of every `src/preparations` production
 * module, and which of them may reach the filesystem directly TODAY.
 *
 * This records the ownership as it actually is at the Task 9A baseline, not the
 * boundary the V3 design targets. Several operation adapters still perform their own
 * filesystem work; that is recorded as a Task 9B obligation rather than hidden, so the
 * control stays truthful while the migration is in flight. Narrowing
 * `rawFilesystemAccess` to the eventual lifecycle filesystem owner is what 9B has to
 * earn — the test will fail until the code actually moves.
 */

/**
 * Lifecycle migrations a module may still owe. 9B obligations are raw-filesystem
 * access awaiting the lifecycle filesystem owner; 9D/9E obligations are the
 * destructive paths Task 9C deliberately did not migrate. They are different
 * debts and are never interchangeable — see the structural controls.
 */
type LifecycleMigrationObligation =
  | "9B-move-behind-lifecycle-fs"
  | "9D/9E-root-taking-operation-wrappers"
  | "9D/9E-destructive-traversal";

/** Roles a preparation module may hold in the lifecycle authority model. */
type LifecycleModuleRole =
  | "filesystem-owner" | "driver" | "operation-adapter" | "read-consumer"
  | "record-codec" | "path-schema" | "classifier" | "unrelated-preparation"
  // A primitive OUTSIDE src/preparations that lifecycle code reaches. These were
  // invisible to this model until its scope was DERIVED from reachability rather
  // than a directory literal -- which is how a duplicated staged-delete
  // derivation and a swallowed recursive `rm` both escaped classification while
  // living in modules the lifecycle uses on every operation.
  | "shared-primitive";

/** One classified production module. */
interface LifecycleModuleOwnershipV1 {
  readonly path: string;
  readonly role: LifecycleModuleRole;
  /** True where this module currently imports raw `node:fs` primitives. */
  readonly rawFilesystemAccess: boolean;
  /** Set where this module still owes a named lifecycle migration. */
  readonly migrationObligation?: LifecycleMigrationObligation;
}

/** Every production module under `src/preparations`, classified. */
export const LIFECYCLE_MODULE_OWNERSHIP: readonly LifecycleModuleOwnershipV1[] = [
  { path: "src/preparations/abandonment.ts", role: "operation-adapter", rawFilesystemAccess: false },
  { path: "src/preparations/attempts/admit-result.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/attempts/cancel-delivery.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/attempts/cancel-settlement.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/attempts/checkpoint.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/attempts/custody.ts", role: "unrelated-preparation", rawFilesystemAccess: true },
  { path: "src/preparations/attempts/execute.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/attempts/host-handler.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/attempts/lease.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/attempts/provider.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/attempts/retry.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/attempts/start.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/attempts/types.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/cancellation.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/capacity.ts", role: "read-consumer", rawFilesystemAccess: false },
  { path: "src/preparations/completeness.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/constants.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/effects.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/ephemeral-execute.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/ephemeral-seal.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/ephemeral.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/evidence-capture.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/evidence-store.ts", role: "unrelated-preparation", rawFilesystemAccess: true },
  { path: "src/preparations/expansion.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/exposure.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/fan-out-driver.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/finalization.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/gate-driver.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/gates.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/handoff-bundle.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/handoff.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/ids.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/initial-inputs.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/inputs.ts", role: "unrelated-preparation", rawFilesystemAccess: true },
  { path: "src/preparations/intent-compiler.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/intent-request.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/key-epoch.ts", role: "filesystem-owner", rawFilesystemAccess: true },
  { path: "src/preparations/lifecycle-fs/bounds.ts", role: "filesystem-owner", rawFilesystemAccess: false },
  { path: "src/preparations/lifecycle-fs/directory-observation.ts", role: "filesystem-owner", rawFilesystemAccess: true },
  { path: "src/preparations/lifecycle-fs/key-observation.ts", role: "filesystem-owner", rawFilesystemAccess: false },
  { path: "src/preparations/lifecycle-fs/leaf-observation.ts", role: "filesystem-owner", rawFilesystemAccess: false },
  { path: "src/preparations/lifecycle-fs/namespace.ts", role: "filesystem-owner", rawFilesystemAccess: true },
  { path: "src/preparations/lifecycle-fs/observation-problems.ts", role: "filesystem-owner", rawFilesystemAccess: false },
  { path: "src/preparations/lifecycle-fs/observe.ts", role: "filesystem-owner", rawFilesystemAccess: true },
  { path: "src/preparations/lifecycle-fs/paths.ts", role: "filesystem-owner", rawFilesystemAccess: false },
  { path: "src/preparations/lifecycle-fs/prune-protocol.ts", role: "filesystem-owner", rawFilesystemAccess: true },
  { path: "src/preparations/lifecycle-fs/quarantine-operations.ts", role: "filesystem-owner", rawFilesystemAccess: false },
  { path: "src/preparations/lifecycle-fs/reset-operations.ts", role: "filesystem-owner", rawFilesystemAccess: true },
  { path: "src/preparations/lifecycle-fs/revalidate.ts", role: "filesystem-owner", rawFilesystemAccess: true },
  { path: "src/preparations/lifecycle-fs/storage-observation.ts", role: "filesystem-owner", rawFilesystemAccess: true },
  { path: "src/preparations/lifecycle-fs/types.ts", role: "filesystem-owner", rawFilesystemAccess: false },
  { path: "src/preparations/lifecycle-snapshot/classifier-types.ts", role: "classifier", rawFilesystemAccess: false },
  { path: "src/preparations/lifecycle-snapshot/compat.ts", role: "read-consumer", rawFilesystemAccess: false, migrationObligation: "9D/9E-root-taking-operation-wrappers" },
  { path: "src/preparations/lifecycle-snapshot/postconditions.ts", role: "classifier", rawFilesystemAccess: false },
  { path: "src/preparations/lifecycle-snapshot/prune-classifier.ts", role: "classifier", rawFilesystemAccess: false },
  { path: "src/preparations/lifecycle-snapshot/quarantine-classifier.ts", role: "classifier", rawFilesystemAccess: false },
  { path: "src/preparations/lifecycle-snapshot/read.ts", role: "read-consumer", rawFilesystemAccess: false },
  { path: "src/preparations/lifecycle-snapshot/records.ts", role: "classifier", rawFilesystemAccess: false },
  { path: "src/preparations/lifecycle-snapshot/scan.ts", role: "classifier", rawFilesystemAccess: false },
  { path: "src/preparations/lifecycle-snapshot/storage.ts", role: "classifier", rawFilesystemAccess: false },
  // The shared sweep-target selector: a pure function of an already-captured
  // unit set, read by the mutation gate that AUTHORIZES a sweep and by the sweep
  // executor that acts. It classifies with the projections rather than as an
  // operation adapter precisely because it observes nothing itself — that is
  // what lets two consumers share it without either observing twice.
  { path: "src/preparations/lifecycle-snapshot/sweep-target.ts", role: "classifier", rawFilesystemAccess: false },
  { path: "src/preparations/lifecycle-snapshot/types.ts", role: "classifier", rawFilesystemAccess: false },
  { path: "src/preparations/manifest-graph.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/manifest-parse.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/manifest-store.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/materialization.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/orphan-scan.ts", role: "filesystem-owner", rawFilesystemAccess: false },
  { path: "src/preparations/paths.ts", role: "path-schema", rawFilesystemAccess: false },
  { path: "src/preparations/plan-bounds.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/plan-graph.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/plan-parse-helpers.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/plan-parse.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/plan-types.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/preview.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/principals.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/problems.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/proposals.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  // The verified-delete engine, sibling of quarantine-move. Reached only from the
  // driver's engine switch; performs no raw filesystem access of its own, routing
  // every mutation through lifecycle-fs under the driver's permit.
  { path: "src/preparations/prune-delete.ts", role: "driver", rawFilesystemAccess: false },
  // The one-phase destroy engine, reached only from the driver's engine switch.
  { path: "src/preparations/quarantine-destroy.ts", role: "driver", rawFilesystemAccess: false },
  { path: "src/preparations/quarantine-move.ts", role: "filesystem-owner", rawFilesystemAccess: true },
  { path: "src/preparations/lifecycle-driver.ts", role: "driver", rawFilesystemAccess: false },
  { path: "src/preparations/lifecycle-mutation-permit.ts", role: "driver", rawFilesystemAccess: false },
  { path: "src/preparations/quarantine.ts", role: "operation-adapter", rawFilesystemAccess: false, migrationObligation: "9D/9E-destructive-traversal" },
  { path: "src/preparations/readiness.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/receipts.ts", role: "record-codec", rawFilesystemAccess: false },
  { path: "src/preparations/reconciliation.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/recovery.ts", role: "read-consumer", rawFilesystemAccess: false },
  { path: "src/preparations/references.ts", role: "read-consumer", rawFilesystemAccess: false },
  { path: "src/preparations/reset-intent-supersession.ts", role: "operation-adapter", rawFilesystemAccess: false },
  { path: "src/preparations/reset.ts", role: "operation-adapter", rawFilesystemAccess: false },
  { path: "src/preparations/retention.ts", role: "operation-adapter", rawFilesystemAccess: false, migrationObligation: "9D/9E-destructive-traversal" },
  { path: "src/preparations/run-budget.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/run-integrity.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/run-parse-helpers.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/run-parse.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/run-store.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/run-types.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/run-validation.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/runner-reconstruct.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/runner.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/schedule.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/selection.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  // The cross-surface preparation service. It composes existing entry points and
  // takes no part in the lifecycle custody model, so it classifies alongside the
  // other non-lifecycle preparation modules rather than as an operation-adapter
  // — that role means an adapter of the lifecycle DRIVER, which these are not.
  // `service-readiness.ts` is the one of them that opens a path: it answers
  // whether `.llmwiki` is there at all, which is a question about the project
  // rather than about any lifecycle registry.
  { path: "src/preparations/service-cancel.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/service-control-transition.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/service-fail.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  // `gate` records authority onto the run and reads the plan through the
  // manifest store; it touches no lifecycle registry, and its authority half is
  // split out only because the read assembly and the write are separate jobs.
  { path: "src/preparations/service-gate-authority.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/service-gate.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  // `handoff` routes to the SELF-LOCKING substrate entry point and reads no
  // registry of its own, so it stays with its sibling operations.
  { path: "src/preparations/service-handoff.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/service-list.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  // `prune` and `sweep` are the first service operations that drive the
  // lifecycle DRIVER, and they still classify here rather than as
  // operation-adapters: that role means an adapter OF the driver — a module
  // supplying `assess`/`materialize` — and these supply neither. They call the
  // public locked entry points `retention.ts` already owns, and read no registry
  // of their own; the pending observation each needs is the GATE's, carried on
  // the acquisition ticket.
  { path: "src/preparations/service-pause.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/service-prune.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/service-readiness.ts", role: "unrelated-preparation", rawFilesystemAccess: true },
  // `service-recovery.ts` wraps the lifecycle PROJECTION and the attempt park,
  // and reads neither registry itself, so it stays with its sibling operations
  // rather than becoming a read-consumer of the custody model.
  { path: "src/preparations/service-recovery.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  // `service-request-capture.ts` is a pure in-memory descriptor read shared by
  // every operation's prologue. It touches no registry and no path.
  { path: "src/preparations/service-request-capture.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  // The CLI-only key-repair operation, added as a discovered member with the
  // reset slice. It classifies the same way `service-prune.ts` and
  // `service-sweep.ts` do and for the same reason: it acquires through the gate
  // and calls one substrate entry point, reading no lifecycle registry itself
  // and opening no path. The gate derives its target; the substrate does its own
  // per-unit classification under the lock.
  { path: "src/preparations/service-reset.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/service-resume.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/service-run-lookup.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  // The read operation shipped with `show`. It reads no lifecycle registry: it
  // projects one run into references. `service-pause.ts`,
  // `service-resume.ts` and `service-control-transition.ts` REJOINED this set
  // with the pause slice, exactly as the note here said they would — the control
  // is a SET, so they are added as discovered members rather than by moving a
  // count. Each reads no lifecycle registry either: they resolve one run and
  // append one transition.
  { path: "src/preparations/service-show.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/service-stage.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/service-sweep.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/service.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/stage.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/types.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/preparations/workflow-parent.ts", role: "unrelated-preparation", rawFilesystemAccess: false },
  { path: "src/utils/advisory-file.ts", role: "shared-primitive", rawFilesystemAccess: true },
  { path: "src/utils/atomic-write-durability.ts", role: "shared-primitive", rawFilesystemAccess: true },
  { path: "src/utils/atomic-write-no-replace-durable.ts", role: "shared-primitive", rawFilesystemAccess: true },
  { path: "src/utils/atomic-write.ts", role: "shared-primitive", rawFilesystemAccess: true },
  { path: "src/utils/confined-delete.ts", role: "shared-primitive", rawFilesystemAccess: true },
  { path: "src/utils/confined-read.ts", role: "shared-primitive", rawFilesystemAccess: true },
  { path: "src/utils/constants.ts", role: "shared-primitive", rawFilesystemAccess: false },
  { path: "src/utils/evidence-path.ts", role: "shared-primitive", rawFilesystemAccess: false },
  { path: "src/utils/fs-presence.ts", role: "shared-primitive", rawFilesystemAccess: true },
  { path: "src/utils/hmac-equal.ts", role: "shared-primitive", rawFilesystemAccess: false },
  { path: "src/utils/inventory-arithmetic.ts", role: "shared-primitive", rawFilesystemAccess: false },
  // The no-follow I/O moved here; store classification remains in orphan-scan.
  { path: "src/utils/inventory-scan.ts", role: "shared-primitive", rawFilesystemAccess: true },
  { path: "src/utils/keyed-fifo.ts", role: "shared-primitive", rawFilesystemAccess: false },
  { path: "src/utils/lock-owner.ts", role: "shared-primitive", rawFilesystemAccess: true },
  { path: "src/utils/lock-publication.ts", role: "shared-primitive", rawFilesystemAccess: true },
  { path: "src/utils/lock.ts", role: "shared-primitive", rawFilesystemAccess: true },
  { path: "src/utils/no-follow-open.ts", role: "shared-primitive", rawFilesystemAccess: true },
  { path: "src/utils/output.ts", role: "shared-primitive", rawFilesystemAccess: false },
  { path: "src/utils/path-confine.ts", role: "shared-primitive", rawFilesystemAccess: true },
  { path: "src/utils/planned-bytes.ts", role: "shared-primitive", rawFilesystemAccess: true },
  { path: "src/utils/private-dir.ts", role: "shared-primitive", rawFilesystemAccess: true },
  { path: "src/utils/run-budget-arithmetic.ts", role: "shared-primitive", rawFilesystemAccess: false },
  { path: "src/utils/run-history-projection.ts", role: "shared-primitive", rawFilesystemAccess: false },
  { path: "src/utils/run-store-io.ts", role: "shared-primitive", rawFilesystemAccess: false },
  { path: "src/utils/runtime-capture.ts", role: "shared-primitive", rawFilesystemAccess: false },
  { path: "src/utils/stream-digest.ts", role: "shared-primitive", rawFilesystemAccess: true },
  { path: "src/utils/well-formed-unicode.ts", role: "shared-primitive", rawFilesystemAccess: false },
];

/** Modules permitted to import raw filesystem primitives at this baseline. */
export const CURRENT_FILESYSTEM_OWNERS: readonly string[] =
  LIFECYCLE_MODULE_OWNERSHIP.filter((entry) => entry.rawFilesystemAccess).map((entry) => entry.path);

/**
 * Every module's declared role, pinned exactly.
 *
 * Roles gate three separate controls, so an unpinned role is a way to leave a
 * control's scope rather than satisfy it. Pinning one role leaves the rest
 * launderable; this pins all of them.
 */
export const EXPECTED_MODULE_ROLES = [
  "src/preparations/abandonment.ts :: operation-adapter",
  "src/preparations/attempts/admit-result.ts :: unrelated-preparation",
  "src/preparations/attempts/cancel-delivery.ts :: unrelated-preparation",
  "src/preparations/attempts/cancel-settlement.ts :: unrelated-preparation",
  "src/preparations/attempts/checkpoint.ts :: unrelated-preparation",
  "src/preparations/attempts/custody.ts :: unrelated-preparation",
  "src/preparations/attempts/execute.ts :: unrelated-preparation",
  "src/preparations/attempts/host-handler.ts :: unrelated-preparation",
  "src/preparations/attempts/lease.ts :: unrelated-preparation",
  "src/preparations/attempts/provider.ts :: unrelated-preparation",
  "src/preparations/attempts/retry.ts :: unrelated-preparation",
  "src/preparations/attempts/start.ts :: unrelated-preparation",
  "src/preparations/attempts/types.ts :: unrelated-preparation",
  "src/preparations/cancellation.ts :: unrelated-preparation",
  "src/preparations/capacity.ts :: read-consumer",
  "src/preparations/completeness.ts :: unrelated-preparation",
  "src/preparations/constants.ts :: unrelated-preparation",
  "src/preparations/effects.ts :: unrelated-preparation",
  "src/preparations/ephemeral-execute.ts :: unrelated-preparation",
  "src/preparations/ephemeral-seal.ts :: unrelated-preparation",
  "src/preparations/ephemeral.ts :: unrelated-preparation",
  "src/preparations/evidence-capture.ts :: unrelated-preparation",
  "src/preparations/evidence-store.ts :: unrelated-preparation",
  "src/preparations/expansion.ts :: unrelated-preparation",
  "src/preparations/exposure.ts :: unrelated-preparation",
  "src/preparations/fan-out-driver.ts :: unrelated-preparation",
  "src/preparations/finalization.ts :: unrelated-preparation",
  "src/preparations/gate-driver.ts :: unrelated-preparation",
  "src/preparations/gates.ts :: unrelated-preparation",
  "src/preparations/handoff-bundle.ts :: unrelated-preparation",
  "src/preparations/handoff.ts :: unrelated-preparation",
  "src/preparations/ids.ts :: unrelated-preparation",
  "src/preparations/initial-inputs.ts :: unrelated-preparation",
  "src/preparations/inputs.ts :: unrelated-preparation",
  "src/preparations/intent-compiler.ts :: unrelated-preparation",
  "src/preparations/intent-request.ts :: unrelated-preparation",
  "src/preparations/key-epoch.ts :: filesystem-owner",
  "src/preparations/lifecycle-driver.ts :: driver",
  "src/preparations/lifecycle-fs/bounds.ts :: filesystem-owner",
  "src/preparations/lifecycle-fs/directory-observation.ts :: filesystem-owner",
  "src/preparations/lifecycle-fs/key-observation.ts :: filesystem-owner",
  "src/preparations/lifecycle-fs/leaf-observation.ts :: filesystem-owner",
  "src/preparations/lifecycle-fs/namespace.ts :: filesystem-owner",
  "src/preparations/lifecycle-fs/observation-problems.ts :: filesystem-owner",
  "src/preparations/lifecycle-fs/observe.ts :: filesystem-owner",
  "src/preparations/lifecycle-fs/paths.ts :: filesystem-owner",
  "src/preparations/lifecycle-fs/prune-protocol.ts :: filesystem-owner",
  "src/preparations/lifecycle-fs/quarantine-operations.ts :: filesystem-owner",
  "src/preparations/lifecycle-fs/reset-operations.ts :: filesystem-owner",
  "src/preparations/lifecycle-fs/revalidate.ts :: filesystem-owner",
  "src/preparations/lifecycle-fs/storage-observation.ts :: filesystem-owner",
  "src/preparations/lifecycle-fs/types.ts :: filesystem-owner",
  "src/preparations/lifecycle-mutation-permit.ts :: driver",
  "src/preparations/lifecycle-snapshot/classifier-types.ts :: classifier",
  "src/preparations/lifecycle-snapshot/compat.ts :: read-consumer",
  "src/preparations/lifecycle-snapshot/postconditions.ts :: classifier",
  "src/preparations/lifecycle-snapshot/prune-classifier.ts :: classifier",
  "src/preparations/lifecycle-snapshot/quarantine-classifier.ts :: classifier",
  "src/preparations/lifecycle-snapshot/read.ts :: read-consumer",
  "src/preparations/lifecycle-snapshot/records.ts :: classifier",
  "src/preparations/lifecycle-snapshot/scan.ts :: classifier",
  "src/preparations/lifecycle-snapshot/storage.ts :: classifier",
  "src/preparations/lifecycle-snapshot/sweep-target.ts :: classifier",
  "src/preparations/lifecycle-snapshot/types.ts :: classifier",
  "src/preparations/manifest-graph.ts :: unrelated-preparation",
  "src/preparations/manifest-parse.ts :: unrelated-preparation",
  "src/preparations/manifest-store.ts :: unrelated-preparation",
  "src/preparations/materialization.ts :: unrelated-preparation",
  "src/preparations/orphan-scan.ts :: filesystem-owner",
  "src/preparations/paths.ts :: path-schema",
  "src/preparations/plan-bounds.ts :: unrelated-preparation",
  "src/preparations/plan-graph.ts :: unrelated-preparation",
  "src/preparations/plan-parse-helpers.ts :: unrelated-preparation",
  "src/preparations/plan-parse.ts :: unrelated-preparation",
  "src/preparations/plan-types.ts :: unrelated-preparation",
  "src/preparations/preview.ts :: unrelated-preparation",
  "src/preparations/principals.ts :: unrelated-preparation",
  "src/preparations/problems.ts :: unrelated-preparation",
  "src/preparations/proposals.ts :: unrelated-preparation",
  "src/preparations/prune-delete.ts :: driver",
  "src/preparations/quarantine-destroy.ts :: driver",
  "src/preparations/quarantine-move.ts :: filesystem-owner",
  "src/preparations/quarantine.ts :: operation-adapter",
  "src/preparations/readiness.ts :: unrelated-preparation",
  "src/preparations/receipts.ts :: record-codec",
  "src/preparations/reconciliation.ts :: unrelated-preparation",
  "src/preparations/recovery.ts :: read-consumer",
  "src/preparations/references.ts :: read-consumer",
  "src/preparations/reset-intent-supersession.ts :: operation-adapter",
  "src/preparations/reset.ts :: operation-adapter",
  "src/preparations/retention.ts :: operation-adapter",
  "src/preparations/run-budget.ts :: unrelated-preparation",
  "src/preparations/run-integrity.ts :: unrelated-preparation",
  "src/preparations/run-parse-helpers.ts :: unrelated-preparation",
  "src/preparations/run-parse.ts :: unrelated-preparation",
  "src/preparations/run-store.ts :: unrelated-preparation",
  "src/preparations/run-types.ts :: unrelated-preparation",
  "src/preparations/run-validation.ts :: unrelated-preparation",
  "src/preparations/runner-reconstruct.ts :: unrelated-preparation",
  "src/preparations/runner.ts :: unrelated-preparation",
  "src/preparations/schedule.ts :: unrelated-preparation",
  "src/preparations/selection.ts :: unrelated-preparation",
  "src/preparations/service-cancel.ts :: unrelated-preparation",
  "src/preparations/service-control-transition.ts :: unrelated-preparation",
  "src/preparations/service-fail.ts :: unrelated-preparation",
  "src/preparations/service-gate-authority.ts :: unrelated-preparation",
  "src/preparations/service-gate.ts :: unrelated-preparation",
  "src/preparations/service-handoff.ts :: unrelated-preparation",
  "src/preparations/service-list.ts :: unrelated-preparation",
  "src/preparations/service-pause.ts :: unrelated-preparation",
  "src/preparations/service-prune.ts :: unrelated-preparation",
  "src/preparations/service-readiness.ts :: unrelated-preparation",
  "src/preparations/service-recovery.ts :: unrelated-preparation",
  "src/preparations/service-request-capture.ts :: unrelated-preparation",
  "src/preparations/service-reset.ts :: unrelated-preparation",
  "src/preparations/service-resume.ts :: unrelated-preparation",
  "src/preparations/service-run-lookup.ts :: unrelated-preparation",
  "src/preparations/service-show.ts :: unrelated-preparation",
  "src/preparations/service-stage.ts :: unrelated-preparation",
  "src/preparations/service-sweep.ts :: unrelated-preparation",
  "src/preparations/service.ts :: unrelated-preparation",
  "src/preparations/stage.ts :: unrelated-preparation",
  "src/preparations/types.ts :: unrelated-preparation",
  "src/preparations/workflow-parent.ts :: unrelated-preparation",
  "src/utils/advisory-file.ts :: shared-primitive",
  "src/utils/atomic-write-durability.ts :: shared-primitive",
  "src/utils/atomic-write-no-replace-durable.ts :: shared-primitive",
  "src/utils/atomic-write.ts :: shared-primitive",
  "src/utils/confined-delete.ts :: shared-primitive",
  "src/utils/confined-read.ts :: shared-primitive",
  "src/utils/constants.ts :: shared-primitive",
  "src/utils/evidence-path.ts :: shared-primitive",
  "src/utils/fs-presence.ts :: shared-primitive",
  "src/utils/hmac-equal.ts :: shared-primitive",
  "src/utils/inventory-arithmetic.ts :: shared-primitive",
  "src/utils/inventory-scan.ts :: shared-primitive",
  "src/utils/keyed-fifo.ts :: shared-primitive",
  "src/utils/lock-owner.ts :: shared-primitive",
  "src/utils/lock-publication.ts :: shared-primitive",
  "src/utils/lock.ts :: shared-primitive",
  "src/utils/no-follow-open.ts :: shared-primitive",
  "src/utils/output.ts :: shared-primitive",
  "src/utils/path-confine.ts :: shared-primitive",
  "src/utils/planned-bytes.ts :: shared-primitive",
  "src/utils/private-dir.ts :: shared-primitive",
  "src/utils/run-budget-arithmetic.ts :: shared-primitive",
  "src/utils/run-history-projection.ts :: shared-primitive",
  "src/utils/run-store-io.ts :: shared-primitive",
  "src/utils/runtime-capture.ts :: shared-primitive",
  "src/utils/stream-digest.ts :: shared-primitive",
  "src/utils/well-formed-unicode.ts :: shared-primitive",
] as const;
