/**
 * @file test/operations-packs/pack-fixture.ts
 * @description Builds one valid, canonical single-root operations pack for the
 * operations-pack tests: a full contract-requirements block, one provider
 * requirement, a complete workspace contract, one FULL recipe (real input/output/
 * bounds contracts, a completeness class, and a context -> render -> intent phase
 * chain plus a provider phase, all with real closed bodies), one preparation action (with a string and a
 * provider-role input), and one CLI alias. `serialize` renders the canonical text
 * the parser consumes, so a negative test can mutate a single property while every
 * other field stays well-formed. `allInputKinds` builds one valid instance of
 * every closed input kind (section 14.2) for a positive coverage test.
 */

import { createHash } from "node:crypto";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { HOST_DECLARED_CONTRACT_SET } from "../../src/products/compatibility.js";
import type { Sha256Digest } from "../../src/operations-packs/ids.js";
import type { PackRecipeV2 } from "../../src/operations-packs/recipe-types.js";
import type {
  CompositionLockV1, PackActionInputFieldV2, WorkspaceOperationsPackV2,
} from "../../src/operations-packs/types.js";

/** A deterministic distinct `sha256:` digest derived from a seed. */
export function dg(seed: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}` as Sha256Digest;
}

/** Render one pack or lock as the canonical UTF-8 text the loader consumes. */
export function serialize(value: WorkspaceOperationsPackV2 | CompositionLockV1): string {
  return canonicalBytes(value).toString("utf8");
}

/** The context-assemble phase: gathers bounded evidence from action input. */
function contextPhase(): PackRecipeV2["phases"][number] {
  return {
    phaseId: "assemble", kind: "context", dependencies: [], disposition: "required",
    inputBindings: [{ bindingId: "topic-in", source: "action-input", ref: "topic" }],
    outputSchema: [{ fieldId: "evidence", valueKind: "evidence-ref" }],
    bounds: { maxItems: 128, maxOutputBytes: 65536 }, missingInputDisposition: "fail",
    body: {
      eligibilityPolicyId: "context.default", contentTiers: ["summary", "full"],
      evidenceClasses: ["source", "entity"], itemBudget: 64, byteBudget: 32768,
      tokenBudget: 4096, orderingPolicyId: "stable-id",
    },
  };
}

/** The render-template phase: composes a bounded draft from assembled evidence. */
function renderPhase(): PackRecipeV2["phases"][number] {
  return {
    phaseId: "compose", kind: "render", dependencies: ["assemble"], disposition: "required",
    inputBindings: [{ bindingId: "evidence-in", source: "phase-output", ref: "assemble.evidence" }],
    outputSchema: [{ fieldId: "draft", valueKind: "string" }],
    bounds: { maxItems: 1, maxOutputBytes: 65536 }, missingInputDisposition: "fail",
    body: {
      templateRef: "render.wiki-page", formatId: "markdown",
      escapingPolicyId: "per-node", inputEvidenceRefs: ["evidence"],
    },
  };
}

/** The intent-compile phase: proposes a typed Milestone A mutation from the draft. */
function intentPhase(): PackRecipeV2["phases"][number] {
  return {
    phaseId: "propose", kind: "intent", dependencies: ["compose"], disposition: "required",
    inputBindings: [{ bindingId: "draft-in", source: "phase-output", ref: "compose.draft" }],
    outputSchema: [{ fieldId: "mutation", valueKind: "artifact-ref" }],
    bounds: { maxItems: 1, maxOutputBytes: 65536 }, missingInputDisposition: "fail",
    body: {
      intentTemplateRef: "intent.wiki-artifact",
      intents: [{
        mutationKind: "artifact-upsert", targetProfileClass: "wiki-page",
        fieldMappings: [
          { targetField: "title", source: "phase-input", ref: "draft" },
          { targetField: "revision", source: "constant", value: 1 },
          { targetField: "author", source: "host-identity", identityKind: "principal" },
        ],
      }],
    },
  };
}

/** The provider-resolve phase: binds one declared provider-requirement role. */
function providerPhase(): PackRecipeV2["phases"][number] {
  return {
    phaseId: "provision", kind: "provider", dependencies: [], disposition: "required",
    inputBindings: [], outputSchema: [{ fieldId: "provider-handle", valueKind: "string" }],
    bounds: { maxItems: 1, maxOutputBytes: 4096 }, missingInputDisposition: "fail",
    body: { providerRoleId: "primary-model", requestTemplateRef: "render.provider-request" },
  };
}

/** Build one valid, FULL recipe with a context -> render -> intent chain and a provider phase. */
function buildRecipe(): PackRecipeV2 {
  return {
    recipeId: "demo.prepare", recipeVersion: "1.0.0", atomicityClass: "local-bundle-only",
    inputContract: { fields: [{ fieldId: "topic", valueKind: "string", required: true }] },
    phases: [contextPhase(), renderPhase(), intentPhase(), providerPhase()],
    completenessClasses: [{ classId: "evidence-coverage", disposition: "best-effort" }],
    outputContract: {
      evidenceClass: "wiki-page",
      fields: [{ fieldId: "draft", valueKind: "string", required: true }],
      formatIds: ["markdown"],
    },
    bounds: { maxPhaseInvocations: 8, maxTotalItems: 256, maxOutputBytes: 131072 },
  };
}

/** Build one valid, canonical single-root operations pack. */
export function buildPack(): WorkspaceOperationsPackV2 {
  return {
    schemaVersion: 2,
    packId: "com.example.demo",
    packVersion: "1.0.0",
    displayName: "Demo Pack",
    minLlmwikiVersion: "0.1.0",
    // The declared contract requirements match the host's declared contract set
    // (src/products/compatibility.ts) so this pack is activatable; the two schema
    // versions are the supported values.
    requires: {
      providerContractDigest: HOST_DECLARED_CONTRACT_SET.providerContractDigest,
      orchestrationContractDigest: HOST_DECLARED_CONTRACT_SET.orchestrationContractDigest,
      milestoneAContractDigest: HOST_DECLARED_CONTRACT_SET.milestoneAContractDigest,
      knowledgeProfileSchemaVersion: 1,
      operationsPackSchemaVersion: 2,
      hostHandlerRegistryVersion: HOST_DECLARED_CONTRACT_SET.hostHandlerRegistryVersion,
      hostHandlerRegistryDigest: HOST_DECLARED_CONTRACT_SET.hostHandlerRegistryDigest,
    },
    providerRequirements: [
      {
        roleId: "primary-model",
        disposition: "required",
        capabilityId: "model.chat",
        capabilityContractDigest: dg("cap-contract"),
        allowedProviderPins: [dg("pin-a"), dg("pin-b")],
        defaultProviderPin: dg("pin-a"),
        requiredReadinessDimensions: ["model-ready"],
        requestedGrantKinds: ["model-invoke"],
        // The per-attempt envelope this role REQUESTS; the operator's grant
        // still caps it at invocation, so the effective ceiling is the smaller.
        requestedBounds: {
          maxBrokerRequestsPerAttempt: 2, maxTokensPerAttempt: 2048,
          maxCostMicrosPerAttempt: 25_000, maxWallTimeMsPerAttempt: 20_000,
        },
        fallbackPolicy: { kind: "explicit-ordered", providerPinDigests: [dg("pin-b")] },
      },
    ],
    workspaceContract: {
      workspaceIdentityGrammar: "workspace.default",
      requiredKnowledgeProfileId: "profile.research",
      compatibleKnowledgeProfileDigests: [dg("kp-1")],
      catalogSchemaDependencies: ["catalog.core"],
      sourceSchemaDependencies: ["source.core"],
      allowedContextRootPolicyIds: ["root-workspace"],
      declaredProjectionClasses: ["wiki"],
      requiredSettingFields: ["tone"],
      requiredProviderCapabilityRoles: ["primary-model"],
      supportedImportCompatibilityModes: ["link"],
      productReadinessDimensions: [{
        dimensionId: "model-ready", credentialSlotId: "model-key",
        summaryKey: "fixture.model.affects", degradedSummaryKey: "fixture.model.degraded",
      }],
    },
    recipes: { "demo.prepare": buildRecipe() },
    // The recipe's compose phase names this template; a pack whose render phase
    // references an undeclared template no longer composes or compiles.
    renderTemplates: {
      // The provider phase's request rides the SAME closed template grammar as
      // a rendered page, so the question asked is folded into the recipe digest.
      "render.provider-request": {
        templateId: "render.provider-request", version: "1.0.0",
        // Carries the action input's `topic` INTO the request, so a suite can
        // prove the provider received what the operator asked about rather than
        // merely that a process ran.
        nodes: [
          { kind: "literal", text: "extract entities\nSource: " },
          { kind: "field", field: "topic", escaping: "none" },
          { kind: "literal", text: "\n" },
        ],
      },
      "render.wiki-page": {
        templateId: "render.wiki-page", version: "1.0.0",
        nodes: [
          { kind: "literal", text: "# " },
          { kind: "field", field: "topic", escaping: "none" },
          { kind: "literal", text: "\n" },
        ],
      },
    },
    actions: {
      "demo.run": {
        actionId: "demo.run",
        actionVersion: "1.0.0",
        labelKey: "demo.run.label",
        summaryKey: "demo.run.summary",
        execution: {
          kind: "preparation",
          executionMode: "durable-preparation",
          recipeRef: "demo.prepare",
          outputContractRef: "demo.output",
        },
        inputSchema: {
          topic: { kind: "string", required: true, overridable: true, sensitivityDisplay: "normal", maxBytes: 256 },
          model: { kind: "provider-role", required: true, overridable: false, sensitivityDisplay: "normal", roleId: "primary-model" },
        },
        requestedSurfaceCaps: { cli: "staged-write", sdk: "staged-write" },
        confirmationPolicy: { severityFloor: "host-required", requestPostResultConfirmation: false },
      },
    },
    aliases: [
      { aliasId: "run", surface: "cli", token: "run", actionId: "demo.run", defaultInputs: { topic: "physics" } },
    ],
  };
}

/**
 * Build one valid instance of every closed input-field kind (section 14.2), each
 * with well-formed bounds. Used by a positive coverage test so a parser that
 * dropped a kind or a bound would fail rather than pass a two-kind fixture.
 */
export function allInputKinds(): Record<string, PackActionInputFieldV2> {
  const common = { required: true, overridable: true, sensitivityDisplay: "normal" } as const;
  return {
    "a-string": { ...common, kind: "string", maxBytes: 256 },
    "a-string-list": { ...common, kind: "string-list", maxItems: 8, maxItemBytes: 64 },
    "a-boolean": { ...common, kind: "boolean" },
    "an-integer": { ...common, kind: "integer", minimum: 0, maximum: 10 },
    "a-number": { ...common, kind: "number", minimum: 0.5, maximum: 1.5 },
    "an-enum": { ...common, kind: "enum", values: ["alpha", "beta"] },
    "an-entity-ref": { ...common, kind: "entity-ref", allowedEntityTypes: ["concept"] },
    "an-artifact-ref": { ...common, kind: "artifact-ref", allowedArtifactTypes: ["figure"] },
    "a-source-ref": { ...common, kind: "source-ref" },
    "a-caller-file": { ...common, kind: "caller-file", inputPolicyId: "policy.default" },
    "a-uri": { ...common, kind: "uri", allowedSchemes: ["https"], maxBytes: 512 },
    "a-provider-role": { ...common, kind: "provider-role", roleId: "primary-model" },
    "an-output-format": { ...common, kind: "output-format", formatId: "markdown" },
  };
}
