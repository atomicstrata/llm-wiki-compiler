/**
 * @file src/operations-packs/compiler-types.ts
 * @description The closed request and result value objects of the deterministic
 * pack-action plan compiler (design sections 15.1, 17.3), plus THE phase-kind to
 * host-handler-family lowering table every other compiler module reads.
 *
 * THE REQUEST CARRIES AUTHORITY, THE COMPILER DERIVES NOTHING FROM THE HOST.
 * Every authority identity — the workspace, the active product binding, the
 * verified pack, the installed runtime identities, and the host-pinned safety
 * floor — is resolved by the CALLER (the slice-4 product service) from the
 * verified package and active binding. The compiler only copies those values and
 * derives content digests from them with the repository's single RFC 8785
 * canonicalizer. It never mints, defaults, or infers an authority digest.
 *
 * THE RESULT IS SUFFICIENT TO RUN. {@link CompiledPackActionV1} carries the plan,
 * its canonical document and digest, the REAL closed recipe body of every lowered
 * phase (so the executable per-run registry binds a family that can actually
 * compute), the materialization contract that turns the terminal phase's output
 * evidence into one Milestone A obligation, and the sealed action-input evidence
 * the staging seam admits as the run's frozen initial input set. Nothing here is
 * a placeholder: a field that cannot be sourced is a compile refusal instead.
 */

import type { PackProjectionV2 } from "./recipe-types.js";
import type { RenderTemplateV1 } from "./handlers/types.js";
import type { NormalizedPreparationPlanV1 } from "../preparations/plan-types.js";
import type { EvidenceRefV1, Sha256Digest, WorkflowParentRefV1 } from "../preparations/types.js";
import type { ActiveProductBindingV1 } from "../products/binding/types.js";
import type { IntentPhaseBodyV2, PackPhaseV2 } from "./recipe-types.js";
import type {
  InvocationSurfaceV1, PackActionInputValueV2, WorkspaceOperationsPackV2,
} from "./types.js";

/** The six recipe phase kinds that lower to a registered host-handler family. */
export type WorkPhaseKindV1 =
  | "context" | "select" | "validate" | "render" | "reconcile" | "intent";

/**
 * THE lowering table (design section 16.1): each work phase kind selects exactly
 * one registered host-handler family. It is declared once here because both the
 * runtime lowering and the compile-time binding types are derived from it — a
 * second hand-written copy is exactly how a phase could be sealed against one
 * family and dispatched to another.
 */
export const HOST_HANDLER_FAMILY_BY_PHASE_KIND = {
  context: "context-assemble",
  select: "set-select",
  validate: "rule-evaluate",
  render: "render-template",
  reconcile: "reconcile",
  intent: "intent-compile",
} as const satisfies Readonly<Record<WorkPhaseKindV1, string>>;

/** The closed recipe body one work phase kind declares. */
type PhaseBodyForKindV1<K extends WorkPhaseKindV1> = Extract<PackPhaseV2, { kind: K }>["body"];

/**
 * One lowered work phase's execute-time binding: the logical phase id, the
 * registered family that computes it, the REAL closed recipe body that family
 * consumes, and the phase's finite item/byte bounds. The per-run executable
 * registry (slice 3C) keys these by `logicalPhaseId`, dispatches `body` to the
 * pure family, and builds that family's `PackHandlerBoundsV1` from `bounds` —
 * every family caps its work on a declared `maximumItems`, which lives only in
 * the recipe phase's bounds source and would otherwise be unrecoverable from the
 * normalized plan (whose per-phase bounds carry output bytes but no item count).
 * The pairing is type-closed, so a body can never be handed to the wrong family.
 */
export type CompiledPhaseBindingV1 = {
  [K in WorkPhaseKindV1]: {
    readonly logicalPhaseId: string;
    readonly family: (typeof HOST_HANDLER_FAMILY_BY_PHASE_KIND)[K];
    readonly body: PhaseBodyForKindV1<K>;
    readonly bounds: { readonly maximumItems: number; readonly maximumOutputBytes: number };
  };
}[WorkPhaseKindV1];

/**
 * What the materializer (slice 3C) needs to turn the terminal intent phase's
 * output evidence into ONE Milestone A obligation. Every field is read off the
 * recipe's intent phase and output contract; the payload ceilings repeat the
 * plan's declared materialization capacity so the materializer and the plan
 * cannot disagree about how much it may emit.
 */
export interface CompiledMaterializationSpecV1 {
  readonly producingPhaseId: string;
  /**
   * Every target class the terminal's groups draft — pages AND relation types.
   * This is the proposal-kind set the policy contract admits; a draft whose
   * class is outside it is refused by the proposal authority.
   */
  readonly targetProfileClasses: readonly string[];
  /**
   * The PAGE entity classes alone (artifact-upsert groups) — the classes the
   * active profile must declare and store under wiki/<class>. Relation groups'
   * target classes are relation TYPES, not entities, so directory validation
   * deliberately skips them.
   */
  readonly pageProfileClasses: readonly string[];
  readonly outputEvidenceClass: string;
  /**
   * The completeness classes the recipe declared `required-complete`. A deficit
   * a phase RECORDS under one of these (an invalid-row count, a truncation)
   * refuses materialization: the deficit lives in the phase's published output,
   * which the identity-set completeness derivation never reads, so without this
   * list the run would hand off as if the dropped rows had never existed.
   */
  readonly requiredCompletenessClasses: readonly string[];
  readonly maximumPayloadRefs: number;
  readonly maximumPayloadBytes: number;
  /** The plan-pinned contract the runner requires the materializer to declare. */
  readonly handlerContractDigest: Sha256Digest;
}

/**
 * The sealed action-input evidence. `bytes` are the canonical bytes staging
 * canonicalizes the seed value into, and `ref` is the evidence reference the
 * plan declares as its frozen initial input set — the two agree by construction.
 */
export interface CompiledActionInputV1 {
  readonly ref: EvidenceRefV1;
  readonly bytes: Buffer;
  /**
   * The resolved input value (caller values plus declared defaults) whose
   * canonical bytes are {@link bytes}. Slice 4 stages this value through the
   * value-taking stage seam; carrying it avoids re-parsing `bytes` and the
   * round-trip assumption that would come with it.
   */
  readonly value: Readonly<Record<string, PackActionInputValueV2>>;
}

/**
 * The complete compile request. `binding`, `pack`, the two runtime identity
 * digests, and `safetyFloorDigest` are host-verified authority the caller
 * resolved; `actionId` is already alias-resolved to its canonical id.
 */
export interface CompilePackActionRequestV1 {
  readonly workspaceId: string;
  readonly binding: ActiveProductBindingV1;
  readonly pack: WorkspaceOperationsPackV2;
  readonly actionId: string;
  /**
   * The transport the caller actually invoked through. It selects the action's
   * requested capability ceiling, so the compiler cannot pick it: a compiler
   * that chose the surface would choose the ceiling with it.
   */
  readonly requestedSurface: InvocationSurfaceV1;
  readonly input: Readonly<Record<string, PackActionInputValueV2>>;
  readonly knowledgeRuntimeIdentityDigest: Sha256Digest;
  readonly operationsRuntimeIdentityDigest: Sha256Digest;
  readonly safetyFloorDigest: Sha256Digest;
  /**
   * OPTIONAL one-way reference to the outer workflow run this action serves.
   * When present it is grafted into the CANONICAL plan (before `planDocument`
   * and `planDigest`), so a parent-bound run's digest covers the parent and
   * `verifyParent` can park a preparation whose parent is gone. Omitted-for-
   * default: an action with no parent compiles byte-identically to today.
   */
  readonly workflowParent?: WorkflowParentRefV1;
}

/** The complete compiled action: a runnable plan plus everything to drive it. */
export interface CompiledPackActionV1 {
  readonly plan: NormalizedPreparationPlanV1;
  /** The canonical serialization the text `service.stage` seam consumes. */
  readonly planDocument: string;
  readonly planDigest: Sha256Digest;
  readonly actionId: string;
  readonly recipeId: string;
  readonly phaseBindings: readonly CompiledPhaseBindingV1[];
  readonly materializationSpec: CompiledMaterializationSpecV1;
  readonly initialInput: CompiledActionInputV1;
  /**
   * The pack-declared render templates this recipe's render phases RESOLVED to,
   * keyed by templateRef — resolution happens here at compile so an unknown ref
   * refuses before any run stages, and the runtime performs no registry lookup
   * that could disagree with the ref the plan was sealed against. Empty when the
   * recipe has no render phase. The templates are pack members, so the pack
   * digest the activation verified already covers their bytes.
   */
  readonly renderTemplates: Readonly<Record<string, RenderTemplateV1>>;
  /** Canonical projections this action's phases resolved, folded into the digest. */
  readonly projections: Readonly<Record<string, PackProjectionV2>>;
}
