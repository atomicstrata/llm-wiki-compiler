/**
 * @file src/capability-providers/authority/types.ts
 * @description Closed Provider V2 authority DTOs. These records carry exact
 * permission atoms, operator grant bindings, concrete input exposure,
 * credential descriptors, host pricing, and immutable effect plans without
 * ever carrying a raw secret or executable provider path.
 */
import type {
  BrokerIdV1, CapabilityIdV1, EffectIdV1, InputIdV1, ProviderBoundsV1,
  ProviderPinV1, ProviderPrincipalSurfaceV1, Sha256Digest,
} from "../types.js";

/** The complete launch-time Provider V2 authority vocabulary. */
export const PROVIDER_GRANT_KINDS = Object.freeze([
  "source.read", "network.https", "model.invoke", "credential.use",
  "repository.snapshot", "command.execute", "external.mutate",
  "scheduler.write", "email.send",
] as const);
export type ProviderGrantKindV1 = (typeof PROVIDER_GRANT_KINDS)[number];

/** One exact permission tuple; nulls are meaningful closed-schema values. */
export interface ProviderAuthorityAtomV1 {
  readonly kind: ProviderGrantKindV1;
  readonly brokerId: BrokerIdV1 | null;
  readonly operation: string;
  readonly target: string | null;
  readonly method: string | null;
  readonly credentialSlotId: string | null;
  readonly credentialHandleId: string | null;
  readonly effectClass: string | null;
  readonly inputKind: string | null;
  readonly toolId: string | null;
}

/**
 * The four per-broker aggregate maxima that live outside the frozen closed
 * `ProviderBoundsV1`. Each is a whole invocation ceiling a broker requirement,
 * operations pack, or operator grant may only tighten below its host ceiling.
 */
export interface ProviderBrokerMaximumsV1 {
  readonly httpsTransferBytes: number;
  readonly modelTokens: number;
  readonly modelCostUsd: number;
  readonly commandAcceptedBytes: number;
}

/**
 * Permission and bound ceiling authored by one independent authority leg. An
 * omitted `brokerMaximums` key contributes only the host ceiling; a present
 * key may tighten but never widen a per-broker aggregate maximum.
 */
export interface ProviderGrantScopeV1 {
  readonly schemaVersion: 1;
  readonly authority: readonly ProviderAuthorityAtomV1[];
  readonly bounds: ProviderBoundsV1;
  readonly brokerMaximums?: Readonly<Partial<ProviderBrokerMaximumsV1>>;
}

/** One concrete provider-visible retained-byte input. */
export interface ProviderInputRefV1 {
  readonly inputId: InputIdV1;
  readonly kind: string;
  readonly provenanceLabel: string;
  readonly mediaType: string;
  readonly digest: Sha256Digest;
  readonly byteCount: number;
  readonly materializedToken: string;
  readonly sourceAuthorityDigest?: Sha256Digest;
}

/** Immutable ordered exposure snapshot used by invocation confirmation. */
export interface ProviderInputExposureSetV1 {
  readonly inputs: readonly ProviderInputRefV1[];
  readonly inputExposureSetDigest: Sha256Digest;
}

/** All seven legs needed to resolve one immutable effective grant. */
export interface EffectiveProviderGrantRequestV1 {
  readonly schemaVersion: 1;
  readonly providerPin: ProviderPinV1;
  readonly projectRealpathDigest: Sha256Digest;
  readonly capabilityId: CapabilityIdV1;
  readonly workspaceId: string;
  readonly preparationRunId: string;
  readonly surface: ProviderPrincipalSurfaceV1;
  readonly safetyFloorVersion: string;
  readonly hostFloor: ProviderGrantScopeV1;
  readonly providerMaximum: ProviderGrantScopeV1;
  readonly operationsPackRequest: ProviderGrantScopeV1;
  readonly operatorGrantId: string;
  readonly operatorGrantRevision: number;
  readonly operatorGrantRequestDigest: Sha256Digest;
  readonly effectPlan: ProviderEffectPlanV1;
  readonly priceTableDigest: Sha256Digest | null;
  readonly resourceBounds: ProviderBoundsV1;
  readonly surfaceCap: ProviderBoundsV1;
  readonly exposureInputs: readonly ProviderInputRefV1[];
}

/** Host-resolved authority snapshot; consumers recheck its digest on use. */
export interface EffectiveProviderGrantV1 {
  readonly schemaVersion: 1;
  readonly providerPinDigest: Sha256Digest;
  readonly projectRealpathDigest: Sha256Digest;
  readonly capabilityId: CapabilityIdV1;
  readonly workspaceId: string;
  readonly preparationRunId: string;
  readonly surface: ProviderPrincipalSurfaceV1;
  readonly safetyFloorVersion: string;
  readonly operatorGrantId: string;
  readonly operatorGrantRevision: number;
  readonly operatorGrantRequestDigest: Sha256Digest;
  readonly effectPlanDigest: Sha256Digest;
  readonly priceTableDigest: Sha256Digest | null;
  readonly authority: readonly ProviderAuthorityAtomV1[];
  readonly bounds: ProviderBoundsV1;
  readonly brokerMaximums: ProviderBrokerMaximumsV1;
  readonly exposure: ProviderInputExposureSetV1;
  readonly grantSnapshotDigest: Sha256Digest;
}

/** One persisted operator grant bound to exact project, pin, and request. */
export interface ProviderOperatorGrantRecordV1 {
  readonly grantId: string;
  readonly revision: number;
  readonly projectRealpathDigest: Sha256Digest;
  readonly providerPin: ProviderPinV1;
  readonly providerPinDigest: Sha256Digest;
  readonly grantRequestDigest: Sha256Digest;
  readonly grant: ProviderGrantScopeV1;
  readonly createdAt: string;
}

/** Exact capped provider-grants.json payload. */
export interface ProviderOperatorGrantStateV1 {
  readonly schemaVersion: 1;
  readonly grants: Readonly<Record<string, ProviderOperatorGrantRecordV1>>;
}

/** Honest read classification: only a missing leaf is absent. */
export type ProviderGrantStateReadV1 =
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly state: ProviderOperatorGrantStateV1 }
  | { readonly kind: "unreadable" }
  | { readonly kind: "invalid" };

/** Operator transaction input; the host derives every binding digest. */
export interface WriteOperatorGrantRequestV1 {
  readonly grantId: string;
  readonly projectRoot: string;
  readonly providerPin: ProviderPinV1;
  readonly grant: ProviderGrantScopeV1;
  readonly confirmedGrantRequestDigest: Sha256Digest;
  readonly createdAt: string;
}

/** Closed non-secret credential source descriptors. */
export type CredentialSourceDescriptorV1 =
  | { readonly kind: "environment"; readonly variable: string }
  | { readonly kind: "os-keychain"; readonly service: string; readonly account: string };

/** Operator-configured opaque handle; no raw credential field exists. */
export interface CredentialHandleV1 {
  readonly schemaVersion: 1;
  readonly handleId: string;
  readonly slotId: string;
  readonly source: CredentialSourceDescriptorV1;
  readonly allowedBrokerIds: readonly BrokerIdV1[];
}

/** Frozen handle registry consumed only by host-owned credential adapters. */
export interface CredentialRegistryV1 {
  readonly schemaVersion: 1;
  readonly handles: Readonly<Record<string, CredentialHandleV1>>;
}

/** Honest read classification for descriptor-only operator credential state. */
export type CredentialRegistryStateReadV1 =
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly registry: CredentialRegistryV1 }
  | { readonly kind: "unreadable" }
  | { readonly kind: "invalid" };

declare const credentialAccessBrand: unique symbol;
/** Opaque single-use lease whose secret bytes remain in a host WeakMap. */
export interface CredentialAccessV1 {
  readonly handleId: string;
  readonly slotId: string;
  readonly brokerId: BrokerIdV1;
  readonly sourceKind: CredentialSourceDescriptorV1["kind"];
  readonly [credentialAccessBrand]: true;
}

/** Exact provider-visible bytes or text scanned before release. */
export type ProviderVisibleCredentialValueV1 = string | Uint8Array;

/** Named provider-visible surfaces scanned before bytes can leave the host. */
export interface ProviderVisibleCredentialSurfacesV1 {
  readonly urls: readonly ProviderVisibleCredentialValueV1[];
  readonly headers: readonly ProviderVisibleCredentialValueV1[];
  readonly errors: readonly ProviderVisibleCredentialValueV1[];
  readonly status: readonly ProviderVisibleCredentialValueV1[];
  readonly frames: readonly ProviderVisibleCredentialValueV1[];
  readonly stdout: readonly ProviderVisibleCredentialValueV1[];
  readonly stderr: readonly ProviderVisibleCredentialValueV1[];
  readonly receipts: readonly ProviderVisibleCredentialValueV1[];
  readonly retainedEvidence: readonly ProviderVisibleCredentialValueV1[];
}

/** Host-owned price table and exact billable lookup key. */
export interface HostPriceEntryV1 {
  readonly brokerContract: string;
  readonly service: string;
  readonly modelOrSku: string;
  readonly unit: string;
  readonly priceUsdPerUnit: number;
}
export interface HostPriceTableV1 {
  readonly schemaVersion: 1;
  readonly currency: "USD";
  readonly validFrom: string;
  readonly validUntil: string;
  readonly entries: readonly HostPriceEntryV1[];
}
export interface HostPriceRequestV1 {
  readonly brokerContract: string;
  readonly service: string;
  readonly modelOrSku: string;
  readonly unit: string;
  readonly currency: "USD";
}

/** One exact immutable mutating-effect authorization. */
export type ProviderRollbackSemanticsV1 = "none" | "broker-reversible" | "follow-up-effect-only";
export interface EffectPlanEntryV1 {
  readonly effectId: EffectIdV1;
  readonly effectClass: string;
  readonly brokerId: BrokerIdV1;
  readonly brokerContractVersion: string;
  readonly targetIdentity: string;
  readonly requestDigest: Sha256Digest;
  readonly idempotencyKey: string;
  readonly expectedBounds: Readonly<Record<string, number>>;
  readonly requiredConfirmationClass: string;
  readonly rollbackSemantics: ProviderRollbackSemanticsV1;
  readonly reversesEffectId: EffectIdV1 | null;
}
export interface ProviderEffectPlanV1 {
  readonly schemaVersion: 1;
  readonly bounds: ProviderBoundsV1;
  readonly entries: readonly EffectPlanEntryV1[];
}
export interface ProviderEffectRequestV1 extends EffectPlanEntryV1 {}
