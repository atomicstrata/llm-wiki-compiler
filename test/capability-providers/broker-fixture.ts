/**
 * @file test/capability-providers/broker-fixture.ts
 * @description Real Task 5 authority fixture for Task 6 broker integration
 * tests. It persists operator grants, credential descriptors, and pricing
 * through their production transactions instead of forging resolved grants.
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { afterEach } from "vitest";
import {
  createCredentialRegistry, writeOperatorCredentialRegistry,
} from "../../src/capability-providers/authority/credentials.js";
import {
  hostPriceTableDigest, readHostPriceTable, writeOperatorPriceTable,
} from "../../src/capability-providers/authority/pricing.js";
import {
  operatorGrantRequestDigest, projectGrantScopeDigest, writeOperatorGrant,
} from "../../src/capability-providers/authority/grants-resolve.js";
import type {
  CredentialHandleV1, EffectiveProviderGrantRequestV1, EffectPlanEntryV1,
  HostPriceTableV1, ProviderAuthorityAtomV1, ProviderBrokerMaximumsV1,
  ProviderGrantScopeV1,
} from "../../src/capability-providers/authority/types.js";
import type { ProviderBoundsV1 } from "../../src/capability-providers/types.js";
import {
  parseBrokerId, parseEffectId,
} from "../../src/capability-providers/ids.js";
import {
  brokerRequestDigest, parseBrokerRequestEnvelope,
  type BrokerRequestEnvelopeV1,
} from "../../src/capability-providers/brokers/types.js";
import { deriveExternalEffectId } from "../../src/capability-providers/brokers/receipts.js";
import {
  installResolutionFixture, removeResolutionFixture, type ResolutionFixture,
} from "./resolution-fixture.js";

export interface BrokerAuthorityFixture {
  readonly package: ResolutionFixture;
  readonly request: EffectiveProviderGrantRequestV1;
  cleanup(): Promise<void>;
}

/** Register deterministic cleanup and return a concise fixture tracker. */
export function useBrokerFixtures(afterCleanup?: () => void | Promise<void>) {
  const fixtures: BrokerAuthorityFixture[] = [];
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
    await afterCleanup?.();
  });
  return (fixture: BrokerAuthorityFixture): BrokerAuthorityFixture => {
    fixtures.push(fixture);
    return fixture;
  };
}

/** Create a host-owned atomic effect-state authority shared by dispatchers. */
export function effectStateAuthority() {
  const states = new Map<string, "started" | "unresolved" | "settled">();
  const receipts = new Map<string, unknown>();
  return {
    claimStarted: async (effectId: string) => {
      const existing = states.get(effectId);
      if (existing) return { schemaVersion: 1, state: existing } as const;
      states.set(effectId, "started");
      return { schemaVersion: 1, state: "newly-claimed" } as const;
    },
    settle: async (receipt: { readonly effectId: string; readonly outcome: string }) => {
      const unresolved = receipt.outcome === "outcome-unknown";
      states.set(receipt.effectId, unresolved ? "unresolved" : "settled");
      if (!unresolved) receipts.set(receipt.effectId, receipt);
    },
    settledReceipt: async (effectId: string) => receipts.get(effectId) ?? null,
  };
}

/** Derive the fixture's exact planned effect ID for one invocation request. */
export function brokerEffectId(invocationId: string, requestIndex = 0): string {
  return deriveExternalEffectId("broker-preparation", invocationId, requestIndex);
}

export interface BrokerAuthorityOptions {
  readonly authority: readonly ProviderAuthorityAtomV1[];
  readonly effects?: readonly EffectPlanEntryV1[];
  readonly priceTable?: HostPriceTableV1;
  readonly maximum?: number;
  readonly boundOverrides?: {
    readonly operator?: Partial<ProviderBoundsV1>;
    readonly action?: Partial<ProviderBoundsV1>;
    readonly surface?: Partial<ProviderBoundsV1>;
  };
  readonly brokerMaximumOverrides?: {
    readonly operator?: Partial<ProviderBrokerMaximumsV1>;
    readonly action?: Partial<ProviderBrokerMaximumsV1>;
  };
}

interface BrokerAtomOptions {
  readonly kind: ProviderAuthorityAtomV1["kind"];
  readonly brokerId: string;
  readonly operation: string;
  readonly target?: string;
  readonly method?: string;
  readonly effectClass?: string;
  readonly toolId?: string;
  readonly credentialSlotId?: string;
}

/** Build one exact Task 5 broker atom for concise Task 6 fixtures. */
export function brokerAtom(options: BrokerAtomOptions): ProviderAuthorityAtomV1 {
  return Object.freeze({
    kind: options.kind, brokerId: parseBrokerId(options.brokerId),
    operation: options.operation, target: options.target ?? null,
    method: options.method ?? null, credentialSlotId: options.credentialSlotId ?? null,
    credentialHandleId: null, effectClass: options.effectClass ?? null,
    inputKind: null, toolId: options.toolId ?? null,
  });
}

/** Build and capture the exact generic broker envelope used by dispatch. */
export function brokerEnvelope(
  brokerId: string, payload: Record<string, unknown>, effectId: string | null = null,
): BrokerRequestEnvelopeV1 {
  return parseBrokerRequestEnvelope({
    schemaVersion: 1, requestId: `request-${brokerId}`, brokerId,
    brokerContractVersion: "1.0.0", payload,
    effect: effectId === null ? null : { effectId },
  });
}

/** Author one immutable effect entry over the captured broker request facts. */
export function plannedEffect(
  envelope: BrokerRequestEnvelopeV1, effectClass: string, targetIdentity: string,
  effectId = `effect-${envelope.brokerId}`,
  resolvedOperationFacts?: Record<string, unknown>,
): EffectPlanEntryV1 {
  return Object.freeze({
    effectId: parseEffectId(effectId), effectClass, brokerId: envelope.brokerId,
    brokerContractVersion: envelope.brokerContractVersion,
    targetIdentity, requestDigest: brokerRequestDigest(
      envelope, resolvedOperationFacts as never,
    ),
    idempotencyKey: `idempotency-${envelope.brokerId}`,
    expectedBounds: Object.freeze({ requests: 1 }),
    requiredConfirmationClass: "operator", rollbackSemantics: "none",
    reversesEffectId: null,
  });
}

/** Persist one exact authority setup and return its all-seven-leg request. */
export async function prepareBrokerAuthority(
  options: BrokerAuthorityOptions,
): Promise<BrokerAuthorityFixture> {
  const fixture = await installResolutionFixture();
  try {
    const projectRoot = path.join(fixture.root, "broker-project");
    await mkdir(projectRoot);
    if (options.priceTable) await writeOperatorPriceTable(
      fixture.paths, options.priceTable, hostPriceTableDigest(options.priceTable),
    );
    await writeCredentials(fixture, options.authority);
    const projectDigest = await projectGrantScopeDigest(projectRoot);
    const operatorScope = scope(
      options.authority.map(operatorize), options.maximum ?? 100,
      options.boundOverrides?.operator, options.brokerMaximumOverrides?.operator,
    );
    const confirmation = operatorGrantRequestDigest(fixture.pin, operatorScope, projectDigest);
    await writeOperatorGrant(fixture.paths, {
      grantId: "broker-grant", projectRoot, providerPin: fixture.pin, grant: operatorScope,
      confirmedGrantRequestDigest: confirmation, createdAt: "2026-07-18T12:00:00.000Z",
    });
    const priceTableDigest = options.authority.some((atom) => atom.kind === "model.invoke")
      ? hostPriceTableDigest(await readHostPriceTable(fixture.paths)) : null;
    const request = brokerAuthorityRequest(
      options, fixture, projectDigest, confirmation, priceTableDigest,
    );
    return { package: fixture, request, cleanup: () => removeResolutionFixture(fixture) };
  } catch (error) {
    await removeResolutionFixture(fixture);
    throw error;
  }
}

function brokerAuthorityRequest(
  options: BrokerAuthorityOptions, fixture: ResolutionFixture,
  projectDigest: EffectiveProviderGrantRequestV1["projectRealpathDigest"],
  confirmation: EffectiveProviderGrantRequestV1["operatorGrantRequestDigest"],
  priceTableDigest: EffectiveProviderGrantRequestV1["priceTableDigest"],
): EffectiveProviderGrantRequestV1 {
  const maximum = options.maximum ?? 100;
  return {
    schemaVersion: 1, providerPin: fixture.pin, projectRealpathDigest: projectDigest,
    capabilityId: fixture.pin.capabilityId, workspaceId: "broker-workspace",
    preparationRunId: "broker-preparation", surface: "sdk", safetyFloorVersion: "floor-v1",
    hostFloor: scope(options.authority, maximum), providerMaximum: scope(options.authority, maximum),
    operationsPackRequest: scope(
      options.authority, maximum, options.boundOverrides?.action,
      options.brokerMaximumOverrides?.action,
    ),
    operatorGrantId: "broker-grant", operatorGrantRevision: 1,
    operatorGrantRequestDigest: confirmation,
    effectPlan: { schemaVersion: 1, bounds: bounds(maximum), entries: options.effects ?? [] },
    priceTableDigest, resourceBounds: bounds(maximum),
    surfaceCap: bounds(maximum, options.boundOverrides?.surface), exposureInputs: [],
  };
}

async function writeCredentials(
  fixture: ResolutionFixture,
  authority: readonly ProviderAuthorityAtomV1[],
): Promise<void> {
  const handles = authority.filter((atom) => atom.kind === "credential.use")
    .map(credentialHandle);
  if (handles.length) {
    await writeOperatorCredentialRegistry(fixture.paths, createCredentialRegistry(handles));
  }
}

function credentialHandle(atom: ProviderAuthorityAtomV1): CredentialHandleV1 {
  return {
    schemaVersion: 1, handleId: handleId(atom), slotId: atom.credentialSlotId!,
    source: { kind: "environment", variable: "LLMWIKI_TEST_PROVIDER_TASK6_SECRET" },
    allowedBrokerIds: [atom.brokerId!],
  };
}

function operatorize(atom: ProviderAuthorityAtomV1): ProviderAuthorityAtomV1 {
  return atom.kind === "credential.use"
    ? { ...atom, credentialHandleId: handleId(atom) } : atom;
}

function handleId(atom: ProviderAuthorityAtomV1): string {
  return `${atom.brokerId}-credential`;
}

function scope(
  authority: readonly ProviderAuthorityAtomV1[], maximum: number,
  override?: Partial<ProviderBoundsV1>,
  brokerMaximums?: Partial<ProviderBrokerMaximumsV1>,
): ProviderGrantScopeV1 {
  return { schemaVersion: 1, authority, bounds: bounds(maximum, override),
    ...(brokerMaximums === undefined ? {} : { brokerMaximums }) };
}

/** Wall-time budget large enough that only injected deadlines fire in tests. */
const FIXTURE_WALL_TIME_MS = 3_600_000;

function bounds(maximum: number, override?: Partial<ProviderBoundsV1>): ProviderBoundsV1 {
  return {
    structuredInputBytes: maximum, materializedInputFiles: maximum,
    materializedInputBytes: maximum, scratchFiles: maximum, scratchBytes: maximum,
    outputFiles: maximum, outputBytes: maximum, custodyScanBytes: maximum,
    custodyWallTimeMs: maximum, protocolFrames: maximum, protocolBytes: maximum,
    brokerRequests: maximum, mutatingEffects: maximum, wallTimeMs: FIXTURE_WALL_TIME_MS,
    cpuTimeMs: maximum, memoryBytes: maximum, processCount: maximum,
    ...override,
  };
}
