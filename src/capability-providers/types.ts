/**
 * @file src/capability-providers/types.ts
 * @description Closed foundational DTOs for Provider V2 identity, pins,
 * resource bounds, readiness, public problems, and calling principals. These
 * records describe authority but perform no package I/O or provider execution.
 */
import type { ProviderProblemCodeV1 } from "./problems.js";

declare const sha256DigestBrand: unique symbol;
declare const semanticVersionBrand: unique symbol;
declare const capabilityContractVersionBrand: unique symbol;
declare const providerCoordinateBrand: unique symbol;
declare const providerCoordinateComponentBrand: unique symbol;
declare const providerIdBrand: unique symbol;
declare const capabilityIdBrand: unique symbol;
declare const brokerIdBrand: unique symbol;
declare const inputIdBrand: unique symbol;
declare const invocationIdBrand: unique symbol;
declare const requestIdBrand: unique symbol;
declare const effectIdBrand: unique symbol;
declare const receiptIdBrand: unique symbol;
declare const backendIdBrand: unique symbol;
declare const providerHostAuthorizationBrand: unique symbol;

export type Sha256Digest = `sha256:${string}` & { readonly [sha256DigestBrand]: true };
export type SemanticVersionV1 = string & { readonly [semanticVersionBrand]: true };
export type CapabilityContractVersionV1 = string & {
  readonly [capabilityContractVersionBrand]: true;
};
export type ProviderCoordinateV1 = string & { readonly [providerCoordinateBrand]: true };
export type ProviderCoordinateComponentV1 = string & {
  readonly [providerCoordinateComponentBrand]: true;
};
export type ProviderIdV1 = string & { readonly [providerIdBrand]: true };
export type CapabilityIdV1 = string & { readonly [capabilityIdBrand]: true };
export type BrokerIdV1 = string & { readonly [brokerIdBrand]: true };
export type InputIdV1 = string & { readonly [inputIdBrand]: true };
export type InvocationIdV1 = string & { readonly [invocationIdBrand]: true };
export type RequestIdV1 = string & { readonly [requestIdBrand]: true };
export type EffectIdV1 = string & { readonly [effectIdBrand]: true };
export type ReceiptIdV1 = string & { readonly [receiptIdBrand]: true };
export type BackendIdV1 = string & { readonly [backendIdBrand]: true };

/** Every validated path-facing logical identity accepted by common guards. */
export type ProviderLogicalIdV1 =
  | ProviderIdV1
  | CapabilityIdV1
  | BrokerIdV1
  | InputIdV1
  | InvocationIdV1
  | RequestIdV1
  | EffectIdV1
  | ReceiptIdV1
  | BackendIdV1;

/** Fully decomposed, exact provider coordinate. */
export interface ParsedProviderCoordinateV1 {
  readonly coordinate: ProviderCoordinateV1;
  readonly tap: ProviderCoordinateComponentV1;
  readonly publisher: ProviderCoordinateComponentV1;
  readonly providerId: ProviderIdV1;
  readonly providerVersion: SemanticVersionV1;
}

/** Exact provider and capability selection; ranges and moving tags are absent. */
export interface ProviderPinV1 {
  readonly schemaVersion: 1;
  readonly coordinate: ProviderCoordinateV1;
  readonly providerId: ProviderIdV1;
  readonly providerVersion: SemanticVersionV1;
  readonly packageDigest: Sha256Digest;
  readonly manifestDigest: Sha256Digest;
  readonly capabilityId: CapabilityIdV1;
  readonly capabilityContractVersion: CapabilityContractVersionV1;
  readonly capabilitySchemaDigest: Sha256Digest;
}

/**
 * All process-start bounds resolved before a provider can execute. This is the
 * frozen closed seventeen-field shape of design section 10.3; the four
 * per-broker aggregate maxima (HTTPS transfer, model tokens, model cost,
 * command bytes) deliberately live outside it in per-broker maxima.
 */
export interface ProviderBoundsV1 {
  readonly structuredInputBytes: number;
  readonly materializedInputFiles: number;
  readonly materializedInputBytes: number;
  readonly scratchFiles: number;
  readonly scratchBytes: number;
  readonly outputFiles: number;
  readonly outputBytes: number;
  readonly custodyScanBytes: number;
  readonly custodyWallTimeMs: number;
  readonly protocolFrames: number;
  readonly protocolBytes: number;
  readonly brokerRequests: number;
  readonly mutatingEffects: number;
  readonly wallTimeMs: number;
  readonly cpuTimeMs: number;
  readonly memoryBytes: number;
  readonly processCount: number;
}

export type ProviderReadinessStateV1 = "ready" | "partially-ready" | "unavailable";
export type ProviderInstallationStateV1 = "builtin" | "signed-remote" | "local-unverified" | "missing";
export type ProviderCompatibilityStateV1 =
  | "compatible"
  | "host-incompatible"
  | "protocol-incompatible"
  | "platform-incompatible";
export type ProviderIntegrityStateV1 = "verified" | "invalid" | "revoked" | "unavailable";
export type ProviderRevocationEvidenceStateV1 = "current" | "stale-accepted" | "unavailable" | "not-applicable";
export type ProviderIsolationStateV1 = "available" | "unavailable";
export type ProviderGrantStateV1 = "satisfied" | "partial" | "missing";
export type ProviderCredentialStateV1 = "present" | "partial" | "missing" | "unreadable";

/** Stable public problem record shared by every provider-facing surface. */
export interface ProviderProblemV1 {
  readonly code: ProviderProblemCodeV1;
  readonly severity: "warning" | "error";
  readonly providerPinDigest: Sha256Digest;
  readonly capabilityId: CapabilityIdV1;
  readonly detail: string;
  readonly retryable: boolean;
}

/** Read-only capability readiness envelope from Provider V2 section 23.2. */
export interface ProviderCapabilityStatusV1 {
  readonly providerPin: ProviderPinV1;
  readonly state: ProviderReadinessStateV1;
  readonly installation: ProviderInstallationStateV1;
  readonly compatibility: ProviderCompatibilityStateV1;
  readonly integrity: ProviderIntegrityStateV1;
  readonly revocationEvidence: ProviderRevocationEvidenceStateV1;
  readonly isolation: ProviderIsolationStateV1;
  readonly grants: ProviderGrantStateV1;
  readonly credentials: ProviderCredentialStateV1;
  readonly problems: readonly ProviderProblemV1[];
  readonly availableBrokerOperations: readonly string[];
  readonly localDevelopment: boolean;
}

/** Frozen caller-surface vocabulary shared by host-owned constructors. */
export const PROVIDER_PRINCIPAL_SURFACES = Object.freeze(["cli", "sdk", "mcp"] as const);
/** Frozen provider-service grant vocabulary; callers never submit these. */
export const PROVIDER_PRINCIPAL_GRANTS = Object.freeze([
  "provider.inspect",
  "provider.invoke",
] as const);

export type ProviderPrincipalSurfaceV1 = (typeof PROVIDER_PRINCIPAL_SURFACES)[number];
export type ProviderPrincipalGrantV1 = (typeof PROVIDER_PRINCIPAL_GRANTS)[number];

/** Immutable caller reference containing identity and surface, never grants. */
export interface ProviderPrincipalV1 {
  readonly schemaVersion: 1;
  readonly principalId: string;
  readonly surface: ProviderPrincipalSurfaceV1;
}

/**
 * Opaque host-resolved service authorization bound to the exact invocation
 * scope. Tasks 5 and 11 own minting and use-boundary revalidation.
 * @expected-unused Host-only consumers land in Tasks 5 and 11.
 */
export interface ProviderHostAuthorizationSnapshotV1 {
  readonly schemaVersion: 1;
  readonly principal: ProviderPrincipalV1;
  readonly grants: readonly ProviderPrincipalGrantV1[];
  readonly projectRealpathDigest: Sha256Digest;
  readonly providerPinDigest: Sha256Digest;
  readonly capabilityId: CapabilityIdV1;
  readonly [providerHostAuthorizationBrand]: true;
}

/**
 * Production-compiled, zero-runtime type assertions for the foundational
 * trust contract. These deliberately fail compilation if brands collapse,
 * caller principals regain grants, or the host snapshot becomes constructible.
 */
type ContractAssignable<Source, Target> = [Source] extends [Target] ? true : false;
type ContractAssertFalse<Value extends false> = Value;
type ContractAssertTrue<Value extends true> = Value;
type ContractEqual<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type _ProviderBoundsAreReadonly = ContractAssertTrue<
  ContractEqual<ProviderBoundsV1, Readonly<ProviderBoundsV1>>
>;
type _ProviderBoundsExcludeBrokerAggregateMaxima = ContractAssertFalse<
  ContractAssignable<
    "httpsTransferBytes" | "modelTokens" | "modelCostUsd" | "commandAcceptedBytes",
    keyof ProviderBoundsV1
  >
>;
type _ProviderProblemsAreReadonly = ContractAssertTrue<
  ContractEqual<ProviderProblemV1, Readonly<ProviderProblemV1>>
>;
type _ProviderStatusIsReadonly = ContractAssertTrue<
  ContractEqual<ProviderCapabilityStatusV1, Readonly<ProviderCapabilityStatusV1>>
>;
type _StatusProblemsAreNotMutable = ContractAssertFalse<
  ContractAssignable<ProviderCapabilityStatusV1["problems"], ProviderProblemV1[]>
>;
type _StatusOperationsAreNotMutable = ContractAssertFalse<
  ContractAssignable<ProviderCapabilityStatusV1["availableBrokerOperations"], string[]>
>;
type _RawCoordinateRequiresParsing = ContractAssertFalse<
  ContractAssignable<"official/publisher/provider@1.2.3", ProviderCoordinateV1>
>;
type _RawSemanticVersionRequiresParsing = ContractAssertFalse<
  ContractAssignable<"1.2.3", SemanticVersionV1>
>;
type _RawCapabilityContractVersionRequiresParsing = ContractAssertFalse<
  ContractAssignable<"capability-contract-v1", CapabilityContractVersionV1>
>;
type _SemanticVersionIsNotCapabilityContractVersion = ContractAssertFalse<
  ContractAssignable<SemanticVersionV1, CapabilityContractVersionV1>
>;
type _RawDigestRequiresParsing = ContractAssertFalse<
  ContractAssignable<
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    Sha256Digest
  >
>;
type _RawProviderIdRequiresParsing = ContractAssertFalse<ContractAssignable<"provider", ProviderIdV1>>;
type _RawCapabilityIdRequiresParsing = ContractAssertFalse<ContractAssignable<"capability", CapabilityIdV1>>;
type _RawBrokerIdRequiresParsing = ContractAssertFalse<ContractAssignable<"broker", BrokerIdV1>>;
type _RawInputIdRequiresParsing = ContractAssertFalse<ContractAssignable<"input", InputIdV1>>;
type _RawInvocationIdRequiresParsing = ContractAssertFalse<ContractAssignable<"invocation", InvocationIdV1>>;
type _RawRequestIdRequiresParsing = ContractAssertFalse<ContractAssignable<"request", RequestIdV1>>;
type _RawEffectIdRequiresParsing = ContractAssertFalse<ContractAssignable<"effect", EffectIdV1>>;
type _RawReceiptIdRequiresParsing = ContractAssertFalse<ContractAssignable<"receipt", ReceiptIdV1>>;
type _RawBackendIdRequiresParsing = ContractAssertFalse<ContractAssignable<"backend", BackendIdV1>>;
type _RawLogicalIdUnionRequiresParsing = ContractAssertFalse<
  ContractAssignable<"raw-id", ProviderLogicalIdV1>
>;
type _ProviderIsNotCapability = ContractAssertFalse<ContractAssignable<ProviderIdV1, CapabilityIdV1>>;
type _CapabilityIsNotBroker = ContractAssertFalse<ContractAssignable<CapabilityIdV1, BrokerIdV1>>;
type _BrokerIsNotInput = ContractAssertFalse<ContractAssignable<BrokerIdV1, InputIdV1>>;
type _InputIsNotInvocation = ContractAssertFalse<ContractAssignable<InputIdV1, InvocationIdV1>>;
type _InvocationIsNotRequest = ContractAssertFalse<ContractAssignable<InvocationIdV1, RequestIdV1>>;
type _RequestIsNotEffect = ContractAssertFalse<ContractAssignable<RequestIdV1, EffectIdV1>>;
type _EffectIsNotReceipt = ContractAssertFalse<ContractAssignable<EffectIdV1, ReceiptIdV1>>;
type _ReceiptIsNotBackend = ContractAssertFalse<ContractAssignable<ReceiptIdV1, BackendIdV1>>;
type _BackendIsNotProvider = ContractAssertFalse<ContractAssignable<BackendIdV1, ProviderIdV1>>;
type _PrincipalReferenceCarriesNoGrants = ContractAssertFalse<
  ContractAssignable<"grants", keyof ProviderPrincipalV1>
>;
type HostAuthorizationPublicShapeV1 = {
  readonly schemaVersion: 1;
  readonly principal: ProviderPrincipalV1;
  readonly grants: readonly ProviderPrincipalGrantV1[];
  readonly projectRealpathDigest: Sha256Digest;
  readonly providerPinDigest: Sha256Digest;
  readonly capabilityId: CapabilityIdV1;
};
type _CallerCannotMintHostAuthorization = ContractAssertFalse<
  ContractAssignable<HostAuthorizationPublicShapeV1, ProviderHostAuthorizationSnapshotV1>
>;
type _HostAuthorizationGrantsAreNotMutable = ContractAssertFalse<
  ContractAssignable<ProviderHostAuthorizationSnapshotV1["grants"], ProviderPrincipalGrantV1[]>
>;
