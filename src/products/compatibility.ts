/**
 * @file src/products/compatibility.ts
 * @description The READ-ONLY, STRUCTURAL compatibility report computed before a
 * product activates (design section 8.3, step 2/3). This slice scopes the report
 * to the STRUCTURAL floor: are the pack and knowledge-profile schema versions
 * supported, do the pack's DECLARED contract requirements (`requires`) exactly
 * match the contract set THIS installed llmwiki release declares it implements
 * (design section 10.2), is the active knowledge profile loadable, and is the
 * operations-pack composition valid. An unsupported schema, a contract requirement
 * the host does not declare, an unloadable profile, or an invalid composition is a
 * STRUCTURAL REFUSAL that blocks activation.
 *
 * DEFERRED (a later slice adds it): the DEEP operational and corpus breadth the
 * spec enumerates — workspace settings, typed corpus and required corpus
 * migrations, active preparations, pending bundles, workflow history, artifacts,
 * retained package references, host/platform, provider installation and
 * isolation, credentials, grants, and adapter status. Those are OPERATIONAL
 * READINESS: their absence becomes structured setup work and MUST NOT block
 * activation, so this report deliberately does not assess them and never reports
 * them as an incompatibility. This function is PURE (no I/O); the activator does
 * the confined reads and feeds it the structural facts.
 */

import type { ProductCompatibilityV1 } from "./types.js";
import { MILESTONE_A_DESIGN_DIGEST } from "../preparations/constants.js";
import type { Sha256Digest } from "./ids.js";

/** The pack schema version this runtime supports (design section 10.1). */
const SUPPORTED_PACK_SCHEMA_VERSION = 2;

/** The knowledge-profile schema version this runtime supports. */
const SUPPORTED_KNOWLEDGE_PROFILE_SCHEMA_VERSION = 1;

/**
 * The contract set THIS installed llmwiki release declares it implements (design
 * section 10.2). Activation recognizes a pack's contract requirements ONLY when
 * they match this set EXACTLY, so a pack authored against a different provider,
 * orchestration, Milestone A, or host-handler-registry contract cannot activate.
 * These are the host's DECLARED contract digests (pinned compatibility evidence,
 * never code imports): `milestoneAContractDigest` reuses the pinned Milestone A V2
 * design digest, and the provider/orchestration/registry digests plus the registry
 * version are the fixed values this release declares.
 */
export interface HostDeclaredContractSetV1 {
  providerContractDigest: Sha256Digest;
  orchestrationContractDigest: Sha256Digest;
  milestoneAContractDigest: Sha256Digest;
  hostHandlerRegistryVersion: string;
  hostHandlerRegistryDigest: Sha256Digest;
}

/** The pinned contract set this release declares (see {@link HostDeclaredContractSetV1}). */
export const HOST_DECLARED_CONTRACT_SET: HostDeclaredContractSetV1 = {
  providerContractDigest:
    "sha256:ab18f347fd1b7aeec0336cd553c9f28a7e2636e5d635c6d688b91f147fd957ed" as Sha256Digest,
  orchestrationContractDigest:
    "sha256:f0fc225083c19b08b63f5c685fdcfdee88f3117ae4d2c54c2423eabeab91a129" as Sha256Digest,
  milestoneAContractDigest: MILESTONE_A_DESIGN_DIGEST as Sha256Digest,
  hostHandlerRegistryVersion: "1.0.0",
  hostHandlerRegistryDigest:
    "sha256:20c38577706597176dee3cde7b5d0d1ea3bb5589bdf58c1b5a41d496a9026bb9" as Sha256Digest,
};

/** The structural facts the activator resolves from the installed package. */
export interface StructuralCompatibilityInputsV1 {
  /** The root operations pack's declared schema version. */
  packSchemaVersion: number;
  /** The active knowledge profile's declared schema version. */
  knowledgeProfileSchemaVersion: number;
  /** The pack's required knowledge-profile schema pin (`requires`). */
  requiredKnowledgeProfileSchemaVersion: number;
  /** The pack's required operations-pack schema pin (`requires`). */
  requiredOperationsPackSchemaVersion: number;
  /** The pack's required provider-contract digest (`requires`). */
  requiredProviderContractDigest: Sha256Digest;
  /** The pack's required orchestration-contract digest (`requires`). */
  requiredOrchestrationContractDigest: Sha256Digest;
  /** The pack's required Milestone A contract digest (`requires`). */
  requiredMilestoneAContractDigest: Sha256Digest;
  /** The pack's required host-handler-registry version (`requires`). */
  requiredHostHandlerRegistryVersion: string;
  /** The pack's required host-handler-registry digest (`requires`). */
  requiredHostHandlerRegistryDigest: Sha256Digest;
  /** Whether the active knowledge profile parsed and validated. */
  knowledgeProfileLoadable: boolean;
  /** Whether the composition graph and its lock recomputed and matched. */
  compositionValid: boolean;
}

/** The structural compatibility verdict and the reasons any dimension refused. */
export interface StructuralCompatibilityReportV1 {
  structurallyCompatible: boolean;
  schemaSupported: boolean;
  contractPinsRecognized: boolean;
  knowledgeProfileLoadable: boolean;
  compositionValid: boolean;
  /** Fail-closed reasons, one per failed dimension; empty when compatible. */
  refusals: string[];
}

/** Whether both the pack and knowledge-profile schema versions are supported. */
function isSchemaSupported(inputs: StructuralCompatibilityInputsV1): boolean {
  return inputs.packSchemaVersion === SUPPORTED_PACK_SCHEMA_VERSION
    && inputs.knowledgeProfileSchemaVersion === SUPPORTED_KNOWLEDGE_PROFILE_SCHEMA_VERSION;
}

/** Whether the pack's required schema pins match the two supported schema versions. */
function areSchemaPinsRecognized(inputs: StructuralCompatibilityInputsV1): boolean {
  return inputs.requiredKnowledgeProfileSchemaVersion === SUPPORTED_KNOWLEDGE_PROFILE_SCHEMA_VERSION
    && inputs.requiredOperationsPackSchemaVersion === SUPPORTED_PACK_SCHEMA_VERSION;
}

/** Whether every declared contract digest/version the pack requires matches the host set. */
function areContractDigestsRecognized(inputs: StructuralCompatibilityInputsV1): boolean {
  return inputs.requiredProviderContractDigest === HOST_DECLARED_CONTRACT_SET.providerContractDigest
    && inputs.requiredOrchestrationContractDigest === HOST_DECLARED_CONTRACT_SET.orchestrationContractDigest
    && inputs.requiredMilestoneAContractDigest === HOST_DECLARED_CONTRACT_SET.milestoneAContractDigest
    && inputs.requiredHostHandlerRegistryVersion === HOST_DECLARED_CONTRACT_SET.hostHandlerRegistryVersion
    && inputs.requiredHostHandlerRegistryDigest === HOST_DECLARED_CONTRACT_SET.hostHandlerRegistryDigest;
}

/**
 * Whether the pack's required contract set is recognized by this runtime: BOTH the
 * two supported schema versions AND every declared contract digest/version in the
 * host's {@link HOST_DECLARED_CONTRACT_SET} (design section 8.3 step 2, 10.2). A
 * pack requiring any contract the host does not declare fails closed here.
 */
function areContractPinsRecognized(inputs: StructuralCompatibilityInputsV1): boolean {
  return areSchemaPinsRecognized(inputs) && areContractDigestsRecognized(inputs);
}

/**
 * Assess STRUCTURAL compatibility from resolved package facts (design section 8.3
 * step 3, structural floor only). Returns a fail-closed report naming each refused
 * dimension; operational readiness is out of scope and never contributes a refusal.
 */
export function assessStructuralCompatibility(
  inputs: StructuralCompatibilityInputsV1,
): StructuralCompatibilityReportV1 {
  const schemaSupported = isSchemaSupported(inputs);
  const contractPinsRecognized = areContractPinsRecognized(inputs);
  const refusals: string[] = [];
  if (!schemaSupported) refusals.push("unsupported pack or knowledge-profile schema version");
  if (!contractPinsRecognized) refusals.push("required contract pin not in the host's declared contract set");
  if (!inputs.knowledgeProfileLoadable) refusals.push("active knowledge profile is not loadable");
  if (!inputs.compositionValid) refusals.push("operations-pack composition is invalid");
  return {
    structurallyCompatible: refusals.length === 0,
    schemaSupported,
    contractPinsRecognized,
    knowledgeProfileLoadable: inputs.knowledgeProfileLoadable,
    compositionValid: inputs.compositionValid,
    refusals,
  };
}

/**
 * The compatibility matrix a package targeting THIS host declares today: the
 * values the activator's structural assessment accepts on the platforms the
 * product suites run. One home, shared by product-package builders and the
 * test fixtures, so a shipped claim and the tested claim cannot drift apart.
 */
export function defaultHostCompatibility(): ProductCompatibilityV1 {
  return {
    minLlmwikiVersion: "0.1.0",
    supportedRuntimes: [{ os: "linux", arch: "x64", runtime: "node" }],
    requiredSandboxBackends: ["seatbelt"],
    supportedHosts: [{ hostId: "cli", minAdapterVersion: "1.0.0" }],
    requiredFeatureIds: ["core"],
    compatibleImportModes: { knowledge: ["merge"], workspace: ["link"] },
    unsupportedCombinations: [{ os: "windows", reasonCode: "unsupported-os" }],
  };
}
