/**
 * @file src/workflows/errors.ts
 * @description Typed errors shared by the run-lifecycle operations.
 *
 * The advance/cancel/fail/resume operations all fail CLOSED rather than guessing:
 * a record the confined store cannot vouch for, a terminal run an active-only op
 * was handed, or an out-of-scope/denied stage-output write each raise a DISTINCT
 * typed error (never a generic `Error`) so callers — and the CLI/SDK surfaces —
 * can branch on the failure mode. These carry NO I/O and NO state logic; they are
 * purely the error vocabulary.
 */

/**
 * Raised when {@link readRun} returns `absent`/`unavailable` for a run a
 * lifecycle op was asked to act on. Fail closed — a run we cannot read is never
 * silently treated as empty or progressed.
 */
export class RunUnavailableError extends Error {
  constructor(
    /** The run id that could not be read. */
    readonly runId: string,
    /** The store's `absent`/`unavailable` detail (or a derived reason). */
    readonly detail: string,
  ) {
    super(`workflow run ${JSON.stringify(runId)} is unavailable: ${detail}`);
    this.name = "RunUnavailableError";
  }
}

/**
 * Raised by `adaptApply` when a LOSSY adaptation (one whose plan reports
 * `unmappable` stage ids) is requested WITHOUT explicit confirmation. Fail closed:
 * the run is left byte-unchanged on disk; the caller is handed the `unmappable`
 * ids so a human can see exactly what would be lost before re-running with confirm.
 */
export class AdaptationRequiresConfirmError extends Error {
  constructor(
    /** The run id the lossy adaptation targeted. */
    readonly runId: string,
    /** The stage ids the active def can no longer map (what a confirm would drop). */
    readonly unmappable: string[],
    /**
     * The wiki page refs (`<entityType>/<slug>`) a confirmed lossy adapt would
     * ORPHAN — recorded so the operator sees exactly what they are confirming
     * (the dropped outputs' pages) inline. Defaults to none for back-compat.
     */
    readonly orphanedOutputs: string[] = [],
  ) {
    super(
      `adapting run ${JSON.stringify(runId)} is lossy: stage(s) ${unmappable.join(", ")} ` +
        `cannot be mapped to the current def; re-run with confirm to apply`,
    );
    this.name = "AdaptationRequiresConfirmError";
  }
}

/**
 * Raised by `adaptApply` when the run already matches the ACTIVE def (its digest
 * equals the current def's digest) — there is nothing to adapt, so the op is a
 * no-op rather than a redundant re-anchor that would bump the version and append
 * an empty `workflow-adapted` event.
 */
export class AlreadyCurrentError extends Error {
  constructor(
    /** The run id that is already current. */
    readonly runId: string,
  ) {
    super(`workflow run ${JSON.stringify(runId)} already matches the active definition; nothing to adapt`);
    this.name = "AlreadyCurrentError";
  }
}

/**
 * Raised when an op requiring an ACTIVE (non-terminal) run is handed a terminal
 * one — or when `resume` is handed a `completed`/`cancelled` run (a position that
 * cannot be resumed). The offending `status` is carried for the caller.
 */
export class RunNotActiveError extends Error {
  constructor(
    /** The run id whose status blocked the operation. */
    readonly runId: string,
    /** The terminal/non-resumable status encountered. */
    readonly status: string,
  ) {
    super(`workflow run ${JSON.stringify(runId)} is not active: status is ${status}`);
    this.name = "RunNotActiveError";
  }
}

/**
 * Raised when a gate approval names a gate the run's CURRENT stage does not
 * declare. Only the current (awaiting-gate) stage's gate is approvable — you
 * cannot approve a gate for a stage the run has not reached. Fail closed.
 */
export class UnknownGateError extends Error {
  constructor(
    /** The run id the approval targeted. */
    readonly runId: string,
    /** The gate id that the current stage does not declare. */
    readonly gateId: string,
  ) {
    super(`gate ${JSON.stringify(gateId)} is not declared by the current stage of run ${JSON.stringify(runId)}`);
    this.name = "UnknownGateError";
  }
}

/**
 * Raised when the approving actor's kind cannot satisfy the gate's required
 * kind — the security rule that an `agent` actor can never satisfy a `human:`
 * gate (and a `system` actor can satisfy neither). Fail closed: nothing is
 * written before this is raised.
 */
export class GateActorMismatchError extends Error {
  constructor(
    /** The run id the approval targeted. */
    readonly runId: string,
    /** The gate id that could not be satisfied. */
    readonly gateId: string,
    /** The actor kind the gate requires (e.g. `human`). */
    readonly required: string,
    /** The actor kind that attempted the approval. */
    readonly actual: string,
  ) {
    super(`gate ${JSON.stringify(gateId)} of run ${JSON.stringify(runId)} requires a ${required} actor, not ${actual}`);
    this.name = "GateActorMismatchError";
  }
}

/**
 * Raised when the SDK (a PROGRAMMATIC surface) attempts to satisfy a `human:` gate
 * (C1). A `human` actor is producible ONLY by the interactive CLI TTY proof, never
 * by a programmatic caller, so an SDK `approveGate` requesting `actorKind:"human"`
 * fails closed here. (An `agent`/`system` actor via the SDK is still subject to the
 * core `actorSatisfies` rule, which a `human:` gate also rejects.)
 */
export class SdkHumanGateError extends Error {
  constructor(
    /** The gate id the SDK caller attempted to satisfy as a human. */
    readonly gateId: string,
  ) {
    super(
      `gate ${JSON.stringify(gateId)} is a human gate and cannot be satisfied via the SDK; ` +
        `a human gate requires interactive confirmation at a terminal`,
    );
    this.name = "SdkHumanGateError";
  }
}

/**
 * Raised when a `trust:` gate is approved here: trust-gate satisfaction (the
 * write path + Trust Guard) is the NEXT slice, not this one. Fail closed rather
 * than recording an approval the Trust Guard never vetted.
 */
export class TrustGateNotHereError extends Error {
  constructor(
    /** The run id the approval targeted. */
    readonly runId: string,
    /** The trust gate id that cannot be approved in this slice. */
    readonly gateId: string,
  ) {
    super(
      `trust gate ${JSON.stringify(gateId)} of run ${JSON.stringify(runId)} is not cleared by "gate approve" — ` +
        `it is a trusted-write gate: set LLMWIKI_TRUSTED_WRITE to grant this profile's writes, then re-submit the stage output`,
    );
    this.name = "TrustGateNotHereError";
  }
}

/**
 * Raised when {@link showAction} is asked for an action the active profile does
 * NOT declare as an OWN key of `workflowActions` — including a prototype-chain id
 * like `"constructor"`. Fail closed: a non-declared id is never resolved to an
 * inherited member; discovery surfaces a clean typed error instead of crashing.
 */
export class UnknownActionError extends Error {
  constructor(
    /** The undeclared action id that was requested. */
    readonly actionId: string,
  ) {
    super(`workflow action ${JSON.stringify(actionId)} is not declared by the active profile`);
    this.name = "UnknownActionError";
  }
}

/**
 * Raised when a workflow action's caller `inputs` violate its declared
 * `inputSchema`: an UNDECLARED input key (fail closed — an action with no
 * `inputSchema` accepts NO inputs), a missing `required` field with no `default`,
 * a runtime type that does not match the declared field `type`, or an `entityRef`
 * whose parsed id is malformed OR whose `entityType` is outside the field's
 * declared `entityTypes`. Validation is PURE and runs BEFORE any authority check
 * or dispatch, so a malformed input can never reach a run-lifecycle op.
 */
export class ActionInputError extends Error {
  constructor(
    /** The action id whose inputs failed validation. */
    readonly actionId: string,
    /** The specific input violation (undeclared key, missing required, type, scope). */
    readonly detail: string,
  ) {
    super(`workflow action ${JSON.stringify(actionId)} received invalid inputs: ${detail}`);
    this.name = "ActionInputError";
  }
}

/**
 * Raised when a workflow action's COMPOSED effective permission cannot satisfy
 * the capability its operation requires — the authority enforcement crux. A
 * `disabled` effective permission, a mutating operation whose effective
 * permission ranks below the required capability, or a `gate` operation a
 * read-only/staged-write surface (or one that does not locally enable the human
 * gate) cannot satisfy each raise this BEFORE any dispatch. Fail closed: the
 * underlying run-lifecycle op is never reached, so no run state is touched.
 */
export class ActionDeniedError extends Error {
  constructor(
    /** The action id whose invocation was denied. */
    readonly actionId: string,
    /** The surface the denied invocation came through. */
    readonly surface: string,
    /** Why the composed authority denied the action (e.g. `disabled`, capability shortfall). */
    readonly reason: string,
  ) {
    super(`workflow action ${JSON.stringify(actionId)} denied on surface ${JSON.stringify(surface)}: ${reason}`);
    this.name = "ActionDeniedError";
  }
}

/**
 * Raised when a workflow action's runId-bearing operation targets a run whose
 * stored `workflowId` does NOT match the action's declared `workflow` — THE
 * action-scope crux. An action grants an OPERATION on its OWN workflow, but the
 * target run is caller-supplied, so a `build`-scoped action handed a `secret`
 * run's id must be refused. A run's `workflowId` is immutable after creation, so
 * this pre-dispatch check is sound (no TOCTOU on an immutable field). Fail
 * closed: the run-lifecycle op is never reached, so the cross-workflow target is
 * left byte-unchanged on disk.
 */
export class ActionRunWorkflowMismatchError extends Error {
  constructor(
    /** The action id whose declared workflow the target run fell outside of. */
    readonly actionId: string,
    /** The workflow the action is declared to operate on. */
    readonly expectedWorkflow: string,
    /** The target run's actual stored `workflowId`. */
    readonly actualWorkflow: string,
  ) {
    super(
      `workflow action ${JSON.stringify(actionId)} operates on workflow ` +
        `${JSON.stringify(expectedWorkflow)} but the target run belongs to ` +
        `${JSON.stringify(actualWorkflow)}`,
    );
    this.name = "ActionRunWorkflowMismatchError";
  }
}

/**
 * Raised when a MUTATING runId-bearing op on the action surface targets a run whose
 * recorded `owner` differs from the current caller identity (M1). A run records the
 * advisory identity that started it; a DIFFERENT caller cannot cancel/advance/resume/
 * gate/adapt/submit it. Fail closed: the op is never reached, so the run is left
 * byte-unchanged. An OWNER-LESS (legacy/pre-M1) run is unrestricted (back-compat).
 * Advisory, not cryptographic — see {@link ../workflows/actor-identity.ts}.
 */
export class RunOwnerMismatchError extends Error {
  constructor(
    /** The run id whose owner the caller did not match. */
    readonly runId: string,
    /** The run's recorded owner identity. */
    readonly owner: string,
    /** The current caller identity that did not match. */
    readonly caller: string,
  ) {
    super(
      `workflow run ${JSON.stringify(runId)} is owned by ${JSON.stringify(owner)}; ` +
        `caller ${JSON.stringify(caller)} cannot mutate it`,
    );
    this.name = "RunOwnerMismatchError";
  }
}

/**
 * Raised when a stage output names an `entityType` the current stage does NOT
 * declare in its `writes` set — THE scope crux. A stage may write ONLY its
 * declared entity types, so an out-of-scope output is refused BEFORE any planning
 * or I/O. Fail closed: the run is left byte-unchanged on disk.
 */
export class StageWriteScopeError extends Error {
  constructor(
    /** The run id the output targeted. */
    readonly runId: string,
    /** The stage id whose `writes` set the output fell outside of. */
    readonly stageId: string,
    /** The out-of-scope entity type the output named. */
    readonly entityType: string,
  ) {
    super(
      `entity type ${JSON.stringify(entityType)} is not in the writes set of ` +
        `stage ${JSON.stringify(stageId)} of run ${JSON.stringify(runId)}`,
    );
    this.name = "StageWriteScopeError";
  }
}

/**
 * Raised when a stage output is submitted to a stage that declares NO `writes`.
 * A write-less stage advances via `advance`, never by submitting an output —
 * there is nothing for the output to write. Fail closed.
 */
export class StageHasNoWritesError extends Error {
  constructor(
    /** The run id the output targeted. */
    readonly runId: string,
    /** The write-less stage id an output was submitted to. */
    readonly stageId: string,
  ) {
    super(
      `stage ${JSON.stringify(stageId)} of run ${JSON.stringify(runId)} declares no writes; advance it instead`,
    );
    this.name = "StageHasNoWritesError";
  }
}

/**
 * Raised when the Trust Guard DENIED a stage-output write: nothing was applied,
 * no gate was satisfied, and the run is byte-unchanged on disk. Distinct from a
 * staged/quarantined decision (which is a non-throwing `applied:false` result) —
 * a `deny` is a hard refusal of the write.
 */
export class StageWriteDeniedError extends Error {
  constructor(
    /** The run id the output targeted. */
    readonly runId: string,
    /** The composed Trust Guard decision that refused the write. */
    readonly decision: string,
  ) {
    super(`stage output write for run ${JSON.stringify(runId)} was refused: decision is ${decision}`);
    this.name = "StageWriteDeniedError";
  }
}

/**
 * Raised when a clean RELATION or LIFECYCLE stage output targets a `trust:`-gated
 * stage WITHOUT the out-of-band operator grant (`LLMWIKI_TRUSTED_WRITE`) — THE
 * C3 trust-gate crux for the non-page kinds. Unlike a `page` write (which STAGES
 * to a review candidate when the grant is absent), a relation/lifecycle write has
 * NO staged-review path, so it cannot be parked for later promotion. It therefore
 * REFUSES to apply: nothing is written, the trust gate is NOT satisfied, and the
 * run is byte-unchanged on disk. The operator must set `LLMWIKI_TRUSTED_WRITE` for
 * the project to permit auto-apply. A clean well-formed output can NEVER
 * auto-satisfy a trust gate on its own.
 */
export class TrustGateRequiresGrantError extends Error {
  constructor(
    /** The run id the output targeted. */
    readonly runId: string,
    /** The trust-gated stage id whose write was refused. */
    readonly stageId: string,
    /** The output kind that cannot be staged for review (`relation`/`lifecycle-transition`). */
    readonly kind: string,
  ) {
    super(
      `a trust-gated ${kind} write for stage ${JSON.stringify(stageId)} of run ${JSON.stringify(runId)} ` +
        `has no staged-review path; it requires an out-of-band LLMWIKI_TRUSTED_WRITE grant`,
    );
    this.name = "TrustGateRequiresGrantError";
  }
}

/**
 * Raised when a workflow stage re-emitted an artifact with an already-written
 * `(artifactType, slug)` but DIFFERENT bytes (M2) — THE immutability crux for the
 * workflow arm. Workflow-produced artifacts are immutable-once-written: a divergent
 * WORKFLOW re-run is REFUSED (never a silent overwrite through the workflow path)
 * so a page that pinned the old sha256 stays stable across a workflow re-run. A
 * re-run reproducing IDENTICAL bytes is a no-op (the existing stable ref is
 * recorded); only a byte divergence raises this. Fail closed: nothing is written,
 * the on-disk artifact is left byte-unchanged, and the run is routed to `failed`
 * (a hard denial, retryable via `resume`).
 */
export class WorkflowArtifactChangedError extends Error {
  constructor(
    /** The artifact type whose recorded bytes the re-run diverged from. */
    readonly artifactType: string,
    /** The artifact slug whose recorded bytes the re-run diverged from. */
    readonly slug: string,
    /** The stable sha256 already recorded on disk for `(artifactType, slug)`. */
    readonly existingSha256: string,
  ) {
    super(
      `artifact ${JSON.stringify(`${artifactType}/${slug}`)} already exists with different bytes ` +
        `(existing sha256 ${existingSha256}); workflow artifacts are immutable-once-written — ` +
        `a re-run must reproduce identical bytes`,
    );
    this.name = "WorkflowArtifactChangedError";
  }
}

/**
 * Raised when the M2 immutability guard CANNOT verify whether a workflow re-run
 * diverges from an already-written artifact because the existing manifest read did
 * not resolve to a trustworthy value — it was `unavailable` (the manifest leaf could
 * not be read/confined) or `malformed` (a regular file carrying corrupt/invalid-shape
 * JSON, which the executor's downstream lstat does NOT catch). "Couldn't verify" is
 * NOT "doesn't qualify": proceeding would let a divergent re-run silently overwrite
 * the on-disk bytes (the executor's applied-once short-circuit also fails false on a
 * non-ok manifest), so this FAILS CLOSED — nothing is written, the on-disk artifact
 * is left byte-unchanged, and the run is routed to `failed` (a hard denial, retryable
 * via `resume` once the manifest is legible again). This is the sibling of
 * {@link WorkflowArtifactChangedError} for the couldn't-read leg of the manifest read.
 */
export class WorkflowArtifactUnverifiableError extends Error {
  constructor(
    /** The artifact type whose immutability could not be verified. */
    readonly artifactType: string,
    /** The artifact slug whose immutability could not be verified. */
    readonly slug: string,
    /** The non-ok manifest read-kind (`"unavailable"` or `"malformed"`) that blocked verification. */
    readonly manifestReadKind: string,
  ) {
    super(
      `artifact ${JSON.stringify(`${artifactType}/${slug}`)} immutability could not be verified ` +
        `(manifest read was ${JSON.stringify(manifestReadKind)}); workflow artifacts are ` +
        `immutable-once-written — a re-run is refused rather than risk overwriting pinned bytes`,
    );
    this.name = "WorkflowArtifactUnverifiableError";
  }
}

/**
 * Raised when a stage-output is re-submitted for a stage whose output is ALREADY
 * recorded in `run.outputs[stageId]` — THE idempotency crux. A stage produces its
 * output AT MOST ONCE; re-submission would re-run the external (page/relation/
 * lifecycle) write a SECOND time, so it is refused with NO second external write
 * and the run left byte-unchanged. A caller who wants to RE-DO the stage must
 * `resume`/re-enter it (which clears the recorded output) first.
 */
export class StageOutputAlreadyAppliedError extends Error {
  constructor(
    /** The run id the re-submission targeted. */
    readonly runId: string,
    /** The stage id whose output is already recorded. */
    readonly stageId: string,
  ) {
    super(
      `stage ${JSON.stringify(stageId)} of run ${JSON.stringify(runId)} already produced its output; ` +
        `re-enter the stage to redo it`,
    );
    this.name = "StageOutputAlreadyAppliedError";
  }
}

/**
 * Raised when a stage-output submit finds a `pendingOutput` INTENT marker for the
 * CURRENT stage — a prior submit persisted its intent, applied (or began applying)
 * the external write, then CRASHED before recording the output and clearing the
 * marker. The external write MAY have landed un-recorded, so this FAILS CLOSED
 * VISIBLY rather than silently re-applying (which would duplicate the write): an
 * operator must reconcile whether the prior write landed before the stage can
 * proceed. The carried `opId` identifies the in-flight operation for reconciliation.
 */
export class StageOutputPendingError extends Error {
  constructor(
    /** The run id with the un-cleared pending intent. */
    readonly runId: string,
    /** The stage id whose prior submit crashed mid-apply. */
    readonly stageId: string,
    /** The deterministic op id of the in-flight (possibly-landed) external write. */
    readonly opId: string,
  ) {
    super(
      `stage ${JSON.stringify(stageId)} of run ${JSON.stringify(runId)} has a pending output ` +
        `(op ${JSON.stringify(opId)}): a prior submit may have written un-recorded and must be reconciled`,
    );
    this.name = "StageOutputPendingError";
  }
}
