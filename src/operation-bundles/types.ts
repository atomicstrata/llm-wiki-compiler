/**
 * @file src/operation-bundles/types.ts
 * @description Closed version-one DTOs for immutable operation-bundle intent.
 * These data-only types expose no callbacks, executable adapters, or paths;
 * every runtime consumer receives objects rebuilt by the manifest parser.
 */

import type { BundleId, CatalogRecordId, MutationId, OperationRunId } from "./ids.js";
import type { CitationRef } from "../relations/types.js";

export type OperationDigest = `sha256:${string}`;
export type PayloadRef = string;
export type OperationDataValue =
  | null
  | boolean
  | number
  | string
  | readonly OperationDataValue[]
  | { readonly [key: string]: OperationDataValue };

export interface KnowledgeAuthorityRef {
  id: string;
  digest: OperationDigest;
}

export interface OperationsAuthorityRef {
  packId: string;
  packDigest: OperationDigest;
  actionId: string;
  actionDescriptorDigest: OperationDigest;
}

export interface OperationInputRef {
  id: string;
  provenance: string;
  digest: OperationDigest;
  byteCount: number;
  selected: boolean;
  rationaleDigest?: OperationDigest;
}

export interface PreparationEvidenceRef {
  type: string;
  provenance: string;
  digest: OperationDigest;
  byteCount: number;
  payloadRef?: PayloadRef;
}

export interface OperationBound {
  name: string;
  unit: "bytes" | "count" | "milliseconds";
  maximum: number;
}

export interface OperationCompleteness {
  attempted: number;
  completed: number;
  skipped: number;
  failed: number;
  requiredMissing: number;
  optionalMissing: number;
  rationaleDigest: OperationDigest;
}

export type ReconciliationResolution =
  | "create-distinct"
  | "update-existing"
  | "merge-evidence"
  | "reject-candidate"
  | "supersede-candidate"
  | "retarget-relations";

export interface OperationReconciliation {
  id: string;
  findingDigest: OperationDigest;
  resolution: ReconciliationResolution;
  rationaleDigest: OperationDigest;
}

export interface OperationPlanningWarning {
  code: string;
  message: string;
}

interface MutationEnvelope {
  index: number;
  mutationId: MutationId;
  dependsOn: readonly number[];
  reconciliationRefs: readonly string[];
}

export interface SourceRetainMutation extends MutationEnvelope {
  kind: "source-retain";
  operation: "create";
  target: { digest: PayloadRef };
  payloadRef: PayloadRef;
  precondition: { kind: "absent-or-same"; digest: OperationDigest; byteCount: number };
  postcondition: { digest: OperationDigest; byteCount: number };
}

export interface PageOperationMutation extends MutationEnvelope {
  kind: "page";
  operation: "create" | "update" | "delete";
  target:
    | { kind: "entity"; entityType: string; slug: string }
    | { kind: "raw"; directory: string; slug: string };
  payloadRef: PayloadRef;
  precondition: { kind: "absent" } | { kind: "digest"; digest: OperationDigest };
  /**
   * What the page must be afterwards. A DELETE declares absence — it has no
   * resulting bytes — so the executor verifies the page is GONE rather than
   * re-reading a digest that cannot exist. Only this mutation kind's
   * postcondition carries the absent arm.
   */
  postcondition: { digest: OperationDigest; byteCount: number } | { kind: "absent" };
}

export interface RelationOperationMutation extends MutationEnvelope {
  kind: "relation";
  operation: "create" | "supersede" | "retarget";
  target: { relationType: string; from: string; to: string; relationId?: string };
  attributes: Readonly<Record<string, OperationDataValue>>;
  evidence?: readonly CitationRef[];
  precondition: { kind: "absent" } | { kind: "record"; recordId: string; digest: OperationDigest };
  postcondition: { digest: OperationDigest; recordId: string };
}

export interface LifecycleOperationMutation extends MutationEnvelope {
  kind: "lifecycle-transition";
  operation: "transition";
  target: { entityType: string; slug: string };
  evidence?: Readonly<Record<string, OperationDataValue>>;
  precondition: { kind: "state"; state: string; pageDigest: OperationDigest };
  postcondition: { state: string; pageDigest: OperationDigest; eventDigest: OperationDigest };
}

export interface ArtifactOperationMutation extends MutationEnvelope {
  kind: "artifact";
  operation: "create";
  target: { artifactType: string; logicalId: string };
  payloadRef: PayloadRef;
  precondition: { kind: "absent" };
  postcondition: {
    digest: OperationDigest;
    manifestDigest: OperationDigest;
    auditDigest: OperationDigest;
  };
}

export interface CatalogOperationMutation extends MutationEnvelope {
  kind: "catalog-record";
  operation: "create" | "supersede";
  target: { logicalRecordId: string; supersedesRecordId?: CatalogRecordId };
  payloadRef: PayloadRef;
  precondition: { kind: "absent" } | { kind: "record"; recordId: CatalogRecordId; digest: OperationDigest };
  postcondition: { digest: OperationDigest; recordId: CatalogRecordId };
}

export interface ProjectionOperationMutation extends MutationEnvelope {
  kind: "projection";
  operation: "render";
  target: {
    recipeId: string;
    recipeDigest: OperationDigest;
    output: string;
    criticality: "required" | "optional";
  };
  precondition: { kind: "absent" } | { kind: "digest"; digest: OperationDigest };
  postcondition: { digest: OperationDigest };
}

export type OperationMutation =
  | SourceRetainMutation
  | PageOperationMutation
  | RelationOperationMutation
  | LifecycleOperationMutation
  | ArtifactOperationMutation
  | CatalogOperationMutation
  | ProjectionOperationMutation;

export interface OperationBundleManifest {
  schemaVersion: 1;
  bundleId: BundleId;
  runId: OperationRunId;
  workspaceId: string;
  createdAt: string;
  createdBy: string;
  knowledgeAuthority: KnowledgeAuthorityRef;
  operationsAuthority: OperationsAuthorityRef;
  grantDigest: OperationDigest;
  safetyFloorDigest: OperationDigest;
  inputs: readonly OperationInputRef[];
  preparationEvidence: readonly PreparationEvidenceRef[];
  bounds: readonly OperationBound[];
  completeness: OperationCompleteness;
  reconciliations: readonly OperationReconciliation[];
  mutations: readonly OperationMutation[];
  planningWarnings: readonly OperationPlanningWarning[];
  supersedesBundleId?: BundleId;
  recoversBundleId?: BundleId;
}

export interface BundleGraphNode {
  bundleId: BundleId;
  workspaceId: string;
  supersedesBundleId?: BundleId;
  recoversBundleId?: BundleId;
  supersededByBundleIds: readonly BundleId[];
  recoveredByBundleIds: readonly BundleId[];
}

export type BundleGraphLookupResult =
  | { status: "ok"; node: BundleGraphNode }
  | { status: "absent" }
  | { status: "unavailable"; problem?: string };

export type BundleGraphLookup = (bundleId: BundleId) => Promise<BundleGraphLookupResult>;
