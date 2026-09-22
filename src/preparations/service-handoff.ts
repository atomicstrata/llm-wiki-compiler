/**
 * @file src/preparations/service-handoff.ts
 * @description The `handoff` operation — stage one settled preparation into its
 * immutable Milestone A operation bundle (design v10 §5 row 10).
 *
 * IT ROUTES THROUGH `handoffPreparation` AND RECONSTRUCTS NOTHING. That entry
 * point is SELF-LOCKING: it acquires the project lock at `handoff` intent through
 * the shared recovery gate and releases it itself. So this operation takes no
 * lock of its own — acquiring one here would either deadlock against it or make
 * the surface refuse on a lock it was about to be handed anyway. An earlier
 * revision of the operation table described handoff as settlement plus a
 * transition append, which would have rebuilt a crash-idempotent seven-boundary
 * flow out of two of its pieces and lost the reserved-identity resume in the
 * process.
 *
 * ITS GRANT IS `preparation.run`, NOT `operation-bundle.approve`. Handoff STAGES
 * the bundle; it does not approve or apply it. Requiring the approval grant would
 * conflate staging with approving, and would hand every host that can stage a
 * preparation the authority to approve the bundle it produces.
 *
 * WHAT THE REQUEST CARRIES, AND WHY IT IS NOT SMALLER. The bundle's obligation
 * set — the compiled intent, the Milestone A authorities, the preparation
 * evidence and the content-addressed payload bytes — is host-authored material,
 * and none of it is derivable from the run: the manifest carries the plan, and
 * the plan does not contain the proposals, reconciliations, targets or
 * completeness a compilation settles. It is passed through to the substrate
 * unchanged and never interpreted here.
 *
 * HONEST LIMIT, stated because it bounds what this surface proves today: nothing
 * in `src/` yet PRODUCES that obligation set. Phase attempt execution is what
 * will, and it has no production driver. This operation is the seam that consumes
 * it — the substrate entry point had zero callers before it — but a caller must
 * bring the obligations, and until the leg runner ships the only callers that can
 * are hosts holding their own compiled material.
 *
 * THE REQUEST CARRIES NO ACTOR AND NO TIMESTAMP. Both are host authority: the
 * actor is projected from the captured principal, and the instant is sampled
 * here. `handoffPreparation` writes the actor onto signed transitions and uses
 * the timestamp as the fixed clock a resumed create must reproduce, so a
 * caller-supplied one would let a caller author a durable identity and pin a
 * bundle's creation instant.
 */

import type { BundleId, OperationRunId } from "../operation-bundles/ids.js";
import type { OperationDigest, PreparationEvidenceRef } from "../operation-bundles/types.js";
import { HANDOFF_STARTABLE_RUN_STATES, HandoffError, handoffPreparation } from "./handoff.js";
import type { HandoffBundleAuthoritiesV1 } from "./handoff-bundle.js";
import type { HandoffId } from "./ids.js";
import type { OperationAdapterMap } from "../operation-bundles/adapter-registry.js";
import type { IntentCompilationRequestV1 } from "./intent-request.js";
import { preparationRunActor } from "./principals.js";
import type { PreparationPrincipal } from "./principals.js";
import type { PreparationRunBinding } from "./run-types.js";
import { capturedOr, deepCaptureData, tryCaptureOwnDataRecord } from "../utils/runtime-capture.js";
import { resolveHostReadiness } from "./service-readiness.js";
import { REQUEST_CAPTURE_REFUSAL, capturedRequest } from "./service-request-capture.js";
import { resolvePreparationRun } from "./service-run-lookup.js";

/**
 * The host-authored material one bundle is assembled from.
 *
 * Named as its own type rather than inlined so a host can build it once and a
 * surface can accept it without restating eleven fields — and so the boundary
 * between "what the run knows" and "what the host brings" is one named thing.
 */
export interface PreparationHandoffObligationsV1 {
  /** The compiled intent, minus the bundle id the substrate reserves. */
  readonly compilation: Omit<IntentCompilationRequestV1, "bundleId">;
  /** The settled Milestone A grant, input, bound and genesis-run authorities. */
  readonly authorities: HandoffBundleAuthoritiesV1;
  /** The preparation evidence admitted into the bundle. */
  readonly preparationEvidence: readonly PreparationEvidenceRef[];
  /** Content-addressed payload bytes, keyed by their own sha256 hex digest. */
  readonly payloads: ReadonlyMap<string, Buffer>;
  /** The bundle this one supersedes, when it supersedes one. */
  readonly supersedesBundleId?: BundleId;
}

/** Request for the `handoff` operation. Carries no actor, surface or grant. */
export interface HandoffRequestV1 {
  /** The settled run to hand off. */
  readonly runId: string;
  /** The host-authored bundle obligations. */
  readonly obligations: PreparationHandoffObligationsV1;
}

/** The closed outcome of one handoff. */
export type HandoffResultV1 =
  | {
    readonly status: "handed-off" | "resumed";
    readonly runId: string;
    readonly handoffId: HandoffId;
    readonly bundleId: BundleId;
    readonly operationRunId: OperationRunId;
    readonly bundleManifestDigest: OperationDigest;
  }
  | { readonly status: "refused"; readonly reason: string };

/**
 * Deep-capture the content-addressed payload bytes.
 *
 * THE MAP COPY WAS THE DANGEROUS HALF-MEASURE. `new Map(source)` fixes which
 * digests are present and leaves every `Buffer` VALUE aliased to the caller's,
 * so a byte written after this call changes the bytes the bundle stages while
 * the key still claims their old sha256. The key IS the digest here, so that is
 * not a changed value — it is a digest asserting content the bundle no longer
 * carries, which is a correctness failure in the content-addressing itself.
 *
 * `Buffer.from` rather than the shared deep-capture primitive, and the reason is
 * now the MAP rather than the byte type: `deepCaptureData` rejects a `Map`
 * outright, so this container needs its own walk whatever the values are. (It
 * once also needed the explicit constructor because the primitive widened a
 * `Buffer` to a plain `Uint8Array`; that was the primitive's defect and has been
 * fixed there, so this line is no longer compensating for it.)
 */
function capturePayloads(payloads: unknown): ReadonlyMap<string, Buffer> | null {
  // A TYPED REFUSAL, NOT A THROW. A caller-supplied value that is not a real
  // `Map`, or whose entries do not convert, used to escape as an untyped error
  // out of a boundary whose contract says it returns `{status: "refused"}`.
  if (!(payloads instanceof Map)) return null;
  try {
    const captured = new Map<string, Buffer>();
    for (const [digest, bytes] of payloads as ReadonlyMap<string, Buffer>) {
      if (typeof digest !== "string") return null;
      captured.set(digest, Buffer.from(bytes));
    }
    return captured;
  } catch {
    return null;
  }
}

/**
 * Deep-capture one data-only subtree through the shared trust-boundary
 * primitive, or `null` when it is not capturable as data.
 *
 * NOT A GENERIC CLONE. `deepCaptureData` rejects proxies, accessors, functions,
 * symbols and non-plain prototypes at every level rather than copying whatever
 * it finds, so a value that survives it is data by construction — which is the
 * property the digest downstream depends on. A rejection becomes an incomplete
 * obligation set rather than an untyped throw out of the service.
 */
function captureData<T>(value: T): T | null {
  // ONLY THE CAPTURE'S OWN REFUSAL becomes an incomplete obligation set. A bare
  // catch here reported ANY failure — a bug in the primitive, an allocation
  // failure, anything unforeseen — as "the handoff obligation set is
  // incomplete", which is a claim about the caller's input that nothing
  // established. #82 made the OUTER read's catch narrow and left this inner one
  // bare, in the same file, in the same change; this closes the asymmetry.
  return capturedOr(() => deepCaptureData(value) as T, () => null);
}

/**
 * Capture the compiled intent, field by field.
 *
 * `adapters` IS CODE, NOT DATA, and is the one field that cannot be deep-copied:
 * it maps mutation kinds to core-constructed store adapters whose methods are the
 * point of them. The container is copied so the caller cannot add or drop an
 * adapter after the boundary; the adapters themselves are host infrastructure
 * arriving through the caller's object rather than caller-authored values.
 * Everything else is operator-authored data and goes through the data capture.
 */
function captureCompilation(
  compilation: unknown,
): Omit<IntentCompilationRequestV1, "bundleId"> | null {
  // DESCRIPTOR-READ FIRST. `const { adapters, ...data } = compilation` is a
  // [[Get]] on every own property, so a getter here executes before the
  // hardened capture ever sees the object — the rest-spread reads them all.
  const record = tryCaptureOwnDataRecord(compilation);
  if (record === null) return null;
  const { adapters, ...data } = record;
  if (!(adapters instanceof Map)) return null;
  const captured = captureData(data);
  if (captured === null) return null;
  return {
    ...(captured as Omit<IntentCompilationRequestV1, "bundleId" | "adapters">),
    adapters: new Map(adapters as OperationAdapterMap),
  };
}

/**
 * Copy the obligation set field by field, synchronously.
 *
 * ALLOWLIST-CONSTRUCTED rather than spread, for the same reason every other
 * captured record here is: a trailing spread lets a caller add a field the
 * substrate might one day read.
 *
 * EVERY ROOT IS CAPTURED TO ITS LEAVES, and the previous version was not. It
 * copied the evidence array and the payload map ONE LEVEL — `[...arr]` and
 * `new Map(m)` — and retained `compilation` and `authorities` whole, by
 * reference. A caller could therefore change compiled targets, settled
 * authorities, evidence records and payload bytes AFTER the public operation had
 * begun, and the demonstrated path reached the durable genesis run: mutating
 * `authorities.operationRun.controlTransitionAllowance` between the call and the
 * first await changed what was committed.
 *
 * That is D-10-9 — boundary input captured once, before the first await — which
 * this call site did not inherit from its siblings. The whole set is fixed here
 * so the reserved bundle-manifest digest is a promise about bytes rather than a
 * snapshot of a moving object.
 */
function captureObligations(
  obligations: PreparationHandoffObligationsV1,
): PreparationHandoffObligationsV1 | null {
  // DESCRIPTOR-READ BEFORE THE FIELDS ARE NAMED. Destructuring is a [[Get]], so
  // the previous version invoked any own accessor on the way to the guard that
  // exists to refuse accessors — the hardened check ran on values a getter had
  // already produced. An accessor that threw escaped as an untyped error out of
  // a boundary documented to return `{status: "refused"}`.
  const record = tryCaptureOwnDataRecord(obligations);
  return record === null ? null : captureObligationRecord(record);
}

/**
 * Capture the four roots out of an already descriptor-read record.
 *
 * Split from the read above so the decode and the capture are separately
 * legible: everything here operates on values no accessor produced.
 */
function captureObligationRecord(
  record: Readonly<Record<string, unknown>>,
): PreparationHandoffObligationsV1 | null {
  const { compilation, authorities, preparationEvidence, payloads, supersedesBundleId } = record;
  // A REFUSAL, NOT A SPREAD OVER `undefined`. Every field here is required in
  // the type and this is still reachable without one — from a JavaScript
  // embedder, or from an own-property read that found nothing where the
  // prototype offered something.
  if (compilation === undefined || authorities === undefined
    || preparationEvidence === undefined || payloads === undefined) {
    return null;
  }
  const captured = {
    compilation: captureCompilation(compilation),
    authorities: captureData(authorities) as HandoffBundleAuthoritiesV1 | null,
    preparationEvidence: captureData(preparationEvidence) as readonly PreparationEvidenceRef[] | null,
    payloads: capturePayloads(payloads),
  };
  if (Object.values(captured).some((value) => value === null)) return null;
  return {
    ...(captured as Required<typeof captured> as PreparationHandoffObligationsV1),
    // READ ONCE, from the descriptor record. It used to be read twice — once to
    // test and once to store — so a getter answering differently on the second
    // read let the guard approve one value while the record carried another.
    ...(supersedesBundleId === undefined
      ? {} : { supersedesBundleId: supersedesBundleId as BundleId }),
  };
}

/**
 * Stage one settled preparation into its Milestone A bundle.
 *
 * `principal` is already captured and already charged its `preparation.run`
 * grant by the service composition.
 *
 * @param root - The project root this invocation acts within.
 * @param principal - The captured host principal the handoff transitions credit.
 * @param request - The run the caller named and the obligations it brought.
 * @returns The verified terminal binding, or the honest reason there is none.
 */
export async function handoffPreparationOperation(
  root: string, principal: PreparationPrincipal, request: HandoffRequestV1,
): Promise<HandoffResultV1> {
  // CAPTURED IN THE SYNCHRONOUS PROLOGUE (D-10-9). The run id is read once and
  // threaded to both the action and the result; the obligations are copied here
  // so a caller mutating its own object after this call returns cannot change
  // what was compiled, staged and digest-pinned.
  //
  // THE OUTER READ IS THE ONE THAT WAS MISSING. Everything below `captureObligations`
  // was hardened against accessors while the read that HANDED it the value stayed a
  // plain `[[Get]]` — and `request.obligations` was read TWICE, once to test for
  // `undefined` and once to pass, so a getter answering differently across them let
  // the guard approve one obligation set while the capture received another. A guard
  // is only as good as the outermost read of the value it guards.
  const captured = capturedRequest<HandoffRequestV1>(request);
  if (captured === null) return { status: "refused", reason: REQUEST_CAPTURE_REFUSAL };
  const runId = captured.runId;
  const supplied = captured.obligations;
  const obligations = supplied === undefined ? null : captureObligations(supplied);
  const at = new Date().toISOString();
  if (obligations === null) {
    return { status: "refused", reason: "the handoff obligation set is incomplete" };
  }
  // READINESS FIRST. The run binding is key-epoch-bound, so a project whose own
  // key cannot be read is not one this operation can act in.
  const ready = await resolveHostReadiness(root);
  if (!ready.ready) return { status: "refused", reason: ready.reason ?? "the project is not ready" };
  const resolved = await resolvePreparationRun(root, runId);
  if (!resolved.ok) return { status: "refused", reason: resolved.reason };
  // Through the substrate's OWN exported set, so this pre-check can never refuse
  // a run `handoffPreparation` would accept, nor take its lock only to throw.
  if (!HANDOFF_STARTABLE_RUN_STATES.has(resolved.run.state)) {
    return {
      status: "refused",
      reason: `only a settled run can be handed off; this run is ${resolved.run.state}`,
    };
  }
  return driveHandoff(root, principal, resolved.binding, runId, obligations, at);
}

/** Invoke the self-locking substrate flow and map its typed refusal. */
async function driveHandoff(
  root: string, principal: PreparationPrincipal,
  binding: PreparationRunBinding, runId: string, obligations: PreparationHandoffObligationsV1, at: string,
): Promise<HandoffResultV1> {
  try {
    const settled = await handoffPreparation(root, {
      binding, actor: preparationRunActor(principal), at,
      compilation: obligations.compilation, authorities: obligations.authorities,
      preparationEvidence: obligations.preparationEvidence, payloads: obligations.payloads,
      ...(obligations.supersedesBundleId === undefined
        ? {} : { supersedesBundleId: obligations.supersedesBundleId }),
    });
    return {
      status: settled.outcome, runId, handoffId: settled.handoffId, bundleId: settled.bundleId,
      operationRunId: settled.operationRunId, bundleManifestDigest: settled.bundleManifestDigest,
    };
  } catch (error) {
    // A HANDOFF-shaped refusal is a returned value, the way every other
    // does-not-qualify answer in this service is. Anything else is a fault and
    // stays a throw: converting it would report a disk failure as a decision.
    if (error instanceof HandoffError) return { status: "refused", reason: error.message };
    throw error;
  }
}
