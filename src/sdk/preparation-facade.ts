/**
 * @file src/sdk/preparation-facade.ts
 * @description The EXPERIMENTAL preparation slice of the `WikiCore` facade — the
 * preparation service's SECOND real caller, and the reason extracting it was
 * justified at all.
 *
 * AN ADAPTER, and nothing else (D-10-1). It imports the service and the
 * service's types; it reaches no preparation substrate module and no filesystem
 * path. Everything a preparation IS lives one layer down, so this surface cannot
 * answer a question differently from the CLI even by accident.
 *
 * AUTHORITY IS THE POINT OF THIS FILE (R-5 / D-10-9). An SDK caller is NOT the
 * local project operator:
 *
 *  - `surface: "sdk"` is STAMPED here and is not caller-overridable, the same
 *    way `runAction` fixes its surface. It matters more here than there:
 *    `effectivePreparationGrants` unions the entire local-operator grant set
 *    into any `cli` principal, so a caller who could set the surface could
 *    promote itself to the local operator in one field.
 *  - An `sdk` principal holds EXACTLY its explicit grants, so the default —
 *    an embedder that names none — can read but cannot mutate. Fail closed.
 *  - The grants come from `createWiki`'s OWN options at CONSTRUCTION and are
 *    copied field by field into a frozen principal. No method argument carries a
 *    grant, an actor or a surface, so there is no request through which
 *    authority can be presented at all — and no INHERITED property is read as
 *    though the embedder had supplied it, which is the variant that defeated the
 *    first version of this file.
 *
 * @experimental Foundation API — the shape may change in a future minor release.
 */

import {
  DEFAULT_CONTROL_TRANSITION_ALLOWANCE, createPreparationService,
} from "../preparations/service.js";
import type {
  GateDecision, PreparationDocumentV1, PreparationHandoffObligationsV1,
  PreparationPrincipal, PreparationPrincipalResolverV1,
} from "../preparations/service.js";
import type {
  SdkGatePreparationInput, SdkPreparationOptions, SdkStagePreparationInput, WikiCore,
} from "./core-types.js";

/** The experimental preparation methods the `WikiCore` facade composes in. */
export type PreparationFacadeSlice = Pick<
  WikiCore,
  "stagePreparation" | "previewPreparation" | "listPreparations" | "showPreparation"
  | "failPreparation"
  | "cancelPreparation" | "pausePreparation" | "resumePreparation"
  | "recoverPreparation" | "gatePreparation"
  | "handoffPreparation" | "prunePreparation" | "sweepPreparations"
>;

/** The identity an embedder that names none acts under. */
const DEFAULT_SDK_PRINCIPAL_ID = "sdk-consumer";

/**
 * Read one OWN property of a caller-supplied object.
 *
 * `options?.grants` is an ordinary property read and WALKS THE PROTOTYPE CHAIN.
 * That defeated the fail-closed default outright: with `Object.prototype.grants`
 * planted, an embedder that asked for nothing was handed `preparation.run` — and
 * `capturePreparationPrincipal`, the hardened primitive that exists to catch
 * exactly this, could not see it, because the facade had already laundered the
 * gadget into a clean own-data record before the guard ran. Reading own
 * properties only puts the truth in front of the guard.
 *
 * EVERY caller-supplied read on this path goes through here, not just the
 * authority ones. The first fix covered the principal and left the stage
 * REQUEST reading plainly, so a planted `controlTransitionAllowance` silently
 * shrank a run's durable control budget — no escalation, but a durable value the
 * caller never chose. Authority and durable state are both worth the same care,
 * and the helper was one function away.
 *
 * IT READS THE DESCRIPTOR, NOT THE PROPERTY, and the distinction is the whole
 * point. `Object.hasOwn` stops a PROTOTYPE-planted gadget and does nothing about
 * an OWN ACCESSOR: `source[key]` then RUNS it, and the facade hands the result
 * to the hardened guard as though it were data. That is the same laundering
 * this docblock was written to describe, one variant along — the previous
 * sentence claimed "reading own properties only puts the truth in front of the
 * guard", and reading own properties BY DESCRIPTOR is what actually does that.
 * A getter cannot execute here, so nothing it returns can be mistaken for a
 * value the caller wrote down.
 */
function own<T extends object, K extends keyof T>(
  source: T | undefined, key: K,
): T[K] | undefined {
  if (source === undefined) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  // An accessor has no `value`; treating it as absent is the fail-closed read,
  // and it lands on the same default an unsupplied property gets.
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value as T[K]
    : undefined;
}

/**
 * The SDK principal, ALLOWLIST-CONSTRUCTED from the embedder's OWN options.
 *
 * Each field is named rather than spread, and each is read with {@link own}
 * rather than with `?.`. Naming the fields stops a caller-supplied `surface`
 * riding along; reading own properties stops an inherited one being read as if
 * the caller had supplied it. Both are needed — the first alone is what shipped,
 * and the prototype-chain variant walked straight past it.
 *
 * EXPORTED, because the product facade builds its service over the SAME
 * preparation authority and must construct it the same way. A second copy of
 * this construction is how one surface would come to stamp its own `surface` or
 * read an inherited `grants` while its sibling did not.
 */
export function sdkPreparationPrincipal(options: SdkPreparationOptions | undefined): PreparationPrincipal {
  const grants = own(options, "grants");
  return Object.freeze({
    id: own(options, "id") ?? DEFAULT_SDK_PRINCIPAL_ID,
    // STAMPED, never read from the caller.
    surface: "sdk" as const,
    // COPIED, so neither a later mutation of the embedder's array nor a shared
    // reference moves authority after construction — the service re-reads the
    // principal's grants on every call, so an alias would let a post-
    // construction `push` land.
    grants: Object.freeze([...(grants ?? [])]),
  });
}

/**
 * A document the embedder already holds in memory, as the service asks for it.
 *
 * Takes `unknown` and checks, because its input is now an OWN-property read that
 * yields `undefined` where the caller supplied nothing. A missing document
 * becomes the service's own typed refusal rather than an `undefined` smuggled
 * into the parser — and, before the own-read, rather than whatever the prototype
 * chain happened to offer.
 */
function inMemoryDocument(text: unknown, label: "plan" | "seed"): Promise<PreparationDocumentV1> {
  return Promise.resolve(typeof text === "string"
    ? { ok: true, text }
    : { ok: false, reason: `no ${label} document was supplied` });
}

/**
 * Build the experimental preparation slice of the `WikiCore` facade bound to `root`.
 *
 * @param root - Normalized absolute project root.
 * @param runQuiet - The facade's quiet-scoping wrapper (output suppressed).
 * @param options - The embedder's preparation identity and grants, if any.
 * @returns The experimental preparation WikiCore methods.
 */
export function buildPreparationFacade(
  root: string,
  runQuiet: <T>(fn: () => Promise<T>) => Promise<T>,
  options?: SdkPreparationOptions,
): PreparationFacadeSlice {
  // Resolved ONCE, at construction. The resolver is the service's only
  // authority source and it closes over a principal no method argument reaches.
  const principal = sdkPreparationPrincipal(options);
  const principals: PreparationPrincipalResolverV1 = { principalFor: () => principal };
  const service = createPreparationService({ root, surface: "sdk", principals });

  /**
   * Capture one stage-or-preview input and hand it to the chosen service method.
   *
   * CAPTURED HERE, in the method's own synchronous body — before `runQuiet`
   * defers anything (D-10-9). The documents used to be read inside the deferred
   * closures, so mutating `input.planDocument` immediately after the call
   * returned changed the document that got staged. Own-reads settled WHICH
   * properties are read; this settles WHEN.
   *
   * FIELD BY FIELD, for the same reason the principal is: the caller supplies two
   * documents and a budget, and nothing else reaches the substrate request.
   */
  function stageOrPreview<ResultV1>(
    input: SdkStagePreparationInput,
    call: (request: Parameters<typeof service.stage>[0]) => Promise<ResultV1>,
  ): Promise<ResultV1> {
    const planDocument = own(input, "planDocument");
    const seedDocument = own(input, "seedDocument");
    // A planted `controlTransitionAllowance` reduced this run's durable budget
    // for a caller who named none — not an escalation, but a durable value the
    // caller never chose, and silence is the whole problem with it.
    const controlTransitionAllowance =
      own(input, "controlTransitionAllowance") ?? DEFAULT_CONTROL_TRANSITION_ALLOWANCE;
    return runQuiet(() => call({
      // The closures capture PRIMITIVES, not the caller's object, so laziness
      // costs nothing: the service still decides when to read them.
      documents: {
        plan: () => inMemoryDocument(planDocument, "plan"),
        seed: () => inMemoryDocument(seedDocument, "seed"),
      },
      controlTransitionAllowance,
    }));
  }

  return {
    // BOTH VERBS THROUGH ONE CAPTURE. `preview` must gate the caller's object
    // exactly as `stage` does — an inherited `planDocument` previewing a plan the
    // embedder never named is the same defect one severity down — so the two
    // share the captured body rather than each re-deriving it.
    previewPreparation: (input) => stageOrPreview(input, (request) => service.preview(request)),

    stagePreparation: (input) => stageOrPreview(input, (request) => service.stage(request)),

    listPreparations: () => runQuiet(() => service.list()),

    // POSITIONAL, and grant-free: there is no options object to gate and no
    // authority decision to make, so the run id is the whole input surface.
    showPreparation: (runId) => runQuiet(() => service.show({ runId })),

    failPreparation: (runId) => runQuiet(() => service.fail({ runId })),

    // POSITIONAL, and that is the whole reason these need no own-gate: a
    // primitive argument has no prototype chain to read an unsupplied property
    // from, so there is no inherited value to launder into a request. The
    // requester recorded on a cancellation comes from the principal this facade
    // constructed, never from anything the caller passes.
    cancelPreparation: (runId) => runQuiet(() => service.cancel({ runId })),

    // POSITIONAL for the same reason. Pause aims at nothing but the run id, and
    // the actor credited on the durable transition is this facade's principal.
    pausePreparation: (runId) => runQuiet(() => service.pause({ runId })),

    // THE EXIT, on the surface where the guarantee has content. A `cli` principal
    // holds every preparation grant by transport; an SDK principal holds exactly
    // what it names, so this is the method that proves a run paused with only
    // `preparation.run` can be released with only `preparation.run`.
    resumePreparation: (runId) => runQuiet(() => service.resume({ runId })),

    recoverPreparation: (runId) => runQuiet(() => service.recovery({ runId })),

    // POSITIONAL for the same reason, and it matters more here than anywhere
    // else on this facade: this is the one embedder-reachable call that destroys
    // bytes, so the only thing that can aim it is the run id in the argument
    // position. There is no options object, so there is nothing a planted
    // prototype property could aim it AT.
    prunePreparation: (runId) => runQuiet(() => service.prune({ runId })),

    // NO ARGUMENT AT ALL. Sweep's target is the project's own registry and the
    // exact unit it may resume is derived under the lock, so there is no input
    // to gate, capture or forge.
    sweepPreparations: () => runQuiet(() => service.sweep()),

    // OWN-GATED, FIELD BY FIELD, in the method's own synchronous body — the same
    // three rules `stagePreparation` needed and for the same three reasons.
    // WHICH properties are read: an inherited `decision` would have decided a
    // gate for an embedder that named none, and an inherited `gateId` would have
    // aimed the decision at a gate they never chose. WHAT is read: `runId` and
    // `gateId` are named rather than spread, so nothing else reaches the request.
    // WHEN: before `runQuiet` defers anything, so mutating the input object after
    // this call returns cannot retarget the decision.
    gatePreparation: (input: SdkGatePreparationInput) => {
      const runId = own(input, "runId");
      const gateId = own(input, "gateId");
      const decision = own(input, "decision");
      const reasonCode = own(input, "reasonCode");
      return runQuiet(() => service.gate({
        // Coerced only in the sense of being read: an absent field becomes a
        // value the service refuses through its own closed vocabulary rather
        // than an `undefined` that reaches the proof author.
        runId: typeof runId === "string" ? runId : "",
        gateId: typeof gateId === "string" ? gateId : "",
        decision: decision as GateDecision,
        ...(typeof reasonCode === "string" ? { reasonCode } : {}),
      }));
    },

    // POSITIONAL for the run id — a primitive argument has no prototype chain to
    // read an unsupplied value from. The obligation set is a caller OBJECT, so
    // it gets the same treatment every other caller object here gets, and for a
    // reason the type system does not cover: these fields are required in
    // TypeScript, but this is a published JavaScript surface, and a JS embedder
    // that omits `payloads` with `Object.prototype.payloads` planted would
    // otherwise have the gadget's bytes staged into an immutable bundle under
    // reserved identities. Typed-and-required is not the same as present.
    handoffPreparation: (runId: string, obligations: PreparationHandoffObligationsV1) => {
      const compilation = own(obligations, "compilation");
      const authorities = own(obligations, "authorities");
      const preparationEvidence = own(obligations, "preparationEvidence");
      const payloads = own(obligations, "payloads");
      const supersedesBundleId = own(obligations, "supersedesBundleId");
      return runQuiet(() => service.handoff({
        runId,
        obligations: {
          compilation, authorities, preparationEvidence, payloads,
          ...(supersedesBundleId === undefined ? {} : { supersedesBundleId }),
        } as PreparationHandoffObligationsV1,
      }));
    },
  };
}
