/**
 * @file test/capability-providers/grant-intersection.test.ts
 * @description Persisted operator authority, exact effect-plan binding,
 * credential-slot mapping, exposure, pricing, and minimum-bound regressions.
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCredentialRegistry, writeOperatorCredentialRegistry,
} from "../../src/capability-providers/authority/credentials.js";
import { effectPlanDigest } from "../../src/capability-providers/authority/effect-plan.js";
import {
  operatorGrantRequestDigest, projectGrantScopeDigest, resolveEffectiveProviderGrant,
  writeOperatorGrant,
} from "../../src/capability-providers/authority/grants-resolve.js";
import {
  hostPriceTableDigest, readHostPriceTable,
} from "../../src/capability-providers/authority/pricing.js";
import type {
  CredentialHandleV1, EffectiveProviderGrantRequestV1, EffectPlanEntryV1,
  ProviderAuthorityAtomV1, ProviderBrokerMaximumsV1, ProviderGrantScopeV1,
} from "../../src/capability-providers/authority/types.js";
import {
  parseBrokerId, parseCapabilityId, parseEffectId, parseSha256Digest,
} from "../../src/capability-providers/ids.js";
import {
  MAX_COMMAND_AGGREGATE_ACCEPTED_BYTES, MAX_HTTPS_AGGREGATE_TRANSFER_BYTES,
  MAX_MODEL_AGGREGATE_BILLABLE_COST_USD, MAX_MODEL_AGGREGATE_TOKENS,
} from "../../src/capability-providers/constants.js";
import type { ProviderBoundsV1 } from "../../src/capability-providers/types.js";
import {
  installResolutionFixture, removeResolutionFixture, type ResolutionFixture,
} from "./resolution-fixture.js";

const KINDS = [
  "source.read", "network.https", "model.invoke", "credential.use",
  "repository.snapshot", "command.execute", "external.mutate",
  "scheduler.write", "email.send",
] as const;
const REQUEST_AUTHORITY_LEGS = ["hostFloor", "providerMaximum"] as const;
const BOUND_LEGS = [
  "hostFloor", "providerMaximum", "operationsPackRequest", "resourceBounds", "surfaceCap",
] as const;
const fixtures: ResolutionFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map(removeResolutionFixture)));

describe("effective provider grant intersection", () => {
  it("refuses caller-self-attested authority that was never persisted", async () => {
    const prepared = await prepare([authorityAtom("source.read")], { persistGrant: false });
    await expect(resolveEffectiveProviderGrant(prepared.fixture.paths, prepared.request))
      .rejects.toThrow(/grant.*missing/i);
  });

  it("retains every requested dimension only after persisted authority resolves", async () => {
    const prepared = await prepare(KINDS.map(authorityAtom));
    const grant = await resolveEffectiveProviderGrant(prepared.fixture.paths, prepared.request);
    expect(grant.authority.map((item) => item.kind)).toEqual(KINDS);
    expect(grant.authority.find((item) => item.kind === "credential.use"))
      .toMatchObject({ credentialSlotId: "api-token", credentialHandleId: "credential-one" });
    expect(grant.bounds.wallTimeMs).toBe(40);
  });

  it.each(KINDS.flatMap((kind) => REQUEST_AUTHORITY_LEGS.map((leg) => [kind, leg] as const)))(
    "refuses %s when the %s leg omits it", async (kind, leg) => {
      const authority = KINDS.map(authorityAtom);
      const prepared = await prepare(authority);
      const narrowed = scope(prepared.request[leg].authority.filter((atom) => atom.kind !== kind), 70);
      await expect(resolveEffectiveProviderGrant(prepared.fixture.paths, {
        ...prepared.request, [leg]: narrowed,
      })).rejects.toThrow(/grant.*missing/i);
    },
  );

  it.each(KINDS)("refuses %s when persisted operator authority omits it", async (kind) => {
    const authority = KINDS.map(authorityAtom);
    const prepared = await prepare(authority, {
      operatorAuthority: authority.filter((atom) => atom.kind !== kind),
    });
    await expect(resolveEffectiveProviderGrant(prepared.fixture.paths, prepared.request))
      .rejects.toThrow(/grant.*missing/i);
  });

  it.each(["hostFloor", "providerMaximum", "operatorGrant"] as const)(
    "never widens the pack request with extra %s authority", async (leg) => {
      const requested = [authorityAtom("source.read")];
      const extra = authorityAtom("network.https");
      const prepared = await prepare(requested, {
        operatorAuthority: leg === "operatorGrant" ? [...requested, extra] : requested,
      });
      const request = leg === "operatorGrant" ? prepared.request : {
        ...prepared.request, [leg]: scope([...requested, extra], 100),
      };
      const grant = await resolveEffectiveProviderGrant(prepared.fixture.paths, request);
      expect(grant.authority).toEqual(requested);
    },
  );

  it.each(BOUND_LEGS)("refuses a negative or missing %s bound", async (leg) => {
    const prepared = await prepare([authorityAtom("source.read")]);
    const current = prepared.request[leg];
    const invalid = !("bounds" in current)
      ? { ...current, wallTimeMs: -1 } : { ...current, bounds: { ...current.bounds, wallTimeMs: -1 } };
    await expect(resolveEffectiveProviderGrant(prepared.fixture.paths, {
      ...prepared.request, [leg]: invalid,
    } as EffectiveProviderGrantRequestV1)).rejects.toThrow(/bounds.*invalid/i);
  });

  it("allows a zero ceiling when no work consumes that dimension", async () => {
    const prepared = await prepare([authorityAtom("source.read")]);
    const grant = await resolveEffectiveProviderGrant(prepared.fixture.paths, {
      ...prepared.request, surfaceCap: { ...prepared.request.surfaceCap, mutatingEffects: 0 },
    });
    expect(grant.bounds.mutatingEffects).toBe(0);
  });

  it("intersects broker aggregate maxima across operator, action, and host ceilings", async () => {
    const prepared = await prepare([authorityAtom("source.read")], {
      operatorBrokerMaximums: { httpsTransferBytes: 11 },
    });
    const action = { ...prepared.request.operationsPackRequest,
      brokerMaximums: { modelTokens: 12, modelCostUsd: 0.25, commandAcceptedBytes: 13 } };
    const grant = await resolveEffectiveProviderGrant(prepared.fixture.paths, {
      ...prepared.request, operationsPackRequest: action,
    });
    expect(grant.brokerMaximums).toMatchObject({
      httpsTransferBytes: 11, modelTokens: 12, modelCostUsd: 0.25,
      commandAcceptedBytes: 13,
    });
    expect(grant.bounds).not.toHaveProperty("httpsTransferBytes");
  });

  it("defaults every unconstrained broker aggregate maximum to its host ceiling", async () => {
    const prepared = await prepare([authorityAtom("source.read")]);
    const grant = await resolveEffectiveProviderGrant(prepared.fixture.paths, prepared.request);
    expect(grant.brokerMaximums).toEqual({
      httpsTransferBytes: MAX_HTTPS_AGGREGATE_TRANSFER_BYTES,
      modelTokens: MAX_MODEL_AGGREGATE_TOKENS,
      modelCostUsd: MAX_MODEL_AGGREGATE_BILLABLE_COST_USD,
      commandAcceptedBytes: MAX_COMMAND_AGGREGATE_ACCEPTED_BYTES,
    });
  });

  it("refuses a broker aggregate maximum that would widen a host ceiling", async () => {
    const prepared = await prepare([authorityAtom("source.read")]);
    const action = { ...prepared.request.operationsPackRequest,
      brokerMaximums: { httpsTransferBytes: MAX_HTTPS_AGGREGATE_TRANSFER_BYTES + 1 } };
    await expect(resolveEffectiveProviderGrant(prepared.fixture.paths, {
      ...prepared.request, operationsPackRequest: action,
    })).rejects.toThrow(/grant.*invalid/i);
  });

  it("requires an exact plan entry only for each requested mutating atom", async () => {
    const readOnly = await prepare([authorityAtom("source.read")]);
    await expect(resolveEffectiveProviderGrant(readOnly.fixture.paths, readOnly.request)).resolves.toBeDefined();
    const mutating = await prepare([authorityAtom("external.mutate")], { effectEntries: [] });
    await expect(resolveEffectiveProviderGrant(mutating.fixture.paths, mutating.request))
      .rejects.toThrow(/grant.*missing/i);
  });

  it("recomputes effect-plan digest and rejects a detached digest field", async () => {
    const prepared = await prepare([authorityAtom("external.mutate")]);
    const grant = await resolveEffectiveProviderGrant(prepared.fixture.paths, prepared.request);
    expect(grant.effectPlanDigest).toBe(effectPlanDigest(prepared.request.effectPlan));
    await expect(resolveEffectiveProviderGrant(prepared.fixture.paths, {
      ...prepared.request, effectPlanDigest: digest("9"),
    } as never)).rejects.toThrow(/grant.*invalid/i);
  });

  it("rejects drift in persisted revision, grant digest, and actual host pricing", async () => {
    const prepared = await prepare([authorityAtom("model.invoke")]);
    await expect(resolveEffectiveProviderGrant(prepared.fixture.paths, {
      ...prepared.request, operatorGrantRevision: 2,
    })).rejects.toThrow(/grant.*drift/i);
    await expect(resolveEffectiveProviderGrant(prepared.fixture.paths, {
      ...prepared.request, operatorGrantRequestDigest: digest("8"),
    })).rejects.toThrow(/grant.*drift/i);
    await expect(resolveEffectiveProviderGrant(prepared.fixture.paths, {
      ...prepared.request, priceTableDigest: digest("7"),
    })).rejects.toThrow(/pricing.*drift/i);
  });

  it("requires a non-null verified price-table digest for model authority", async () => {
    const prepared = await prepare([authorityAtom("model.invoke")]);
    await expect(resolveEffectiveProviderGrant(prepared.fixture.paths, {
      ...prepared.request, priceTableDigest: null,
    })).rejects.toThrow(/pricing.*unavailable/i);
  });

  it("requires source.read authority and resolved bounds for every exposure", async () => {
    const missing = await prepare([]);
    await expect(resolveEffectiveProviderGrant(missing.fixture.paths, {
      ...missing.request, exposureInputs: [exposureInput("retained-source", 1)],
    })).rejects.toThrow(/source.*authority/i);
    const bounded = await prepare([authorityAtom("source.read")]);
    await expect(resolveEffectiveProviderGrant(bounded.fixture.paths, {
      ...bounded.request,
      surfaceCap: { ...bounded.request.surfaceCap, materializedInputBytes: 1 },
      exposureInputs: [exposureInput("retained-source", 2)],
    })).rejects.toThrow(/exposure.*bounds/i);
  });

  it("snapshots exposure inputs before operator-state I/O", async () => {
    const source = authorityAtom("source.read");
    const prepared = await prepare([source]);
    const exposureInputs = [exposureInput("retained-source", 1)];
    const resolution = resolveEffectiveProviderGrant(prepared.fixture.paths, {
      ...prepared.request, exposureInputs,
    });
    exposureInputs[0] = exposureInput("mutated-source", 1);
    await expect(resolution).resolves.toMatchObject({
      exposure: { inputs: [{ kind: "retained-source" }] },
    });
  });

  it("rejects local handles in pack requests and mismatched slot mappings", async () => {
    const credential = authorityAtom("credential.use");
    const prepared = await prepare([credential]);
    await expect(resolveEffectiveProviderGrant(prepared.fixture.paths, {
      ...prepared.request, operationsPackRequest: scope([
        { ...credential, credentialHandleId: "credential-one" },
      ], 80),
    })).rejects.toThrow(/grant.*invalid/i);
    await writeOperatorCredentialRegistry(prepared.fixture.paths,
      createCredentialRegistry([{ ...credentialHandle(), slotId: "other-slot" }]));
    await expect(resolveEffectiveProviderGrant(prepared.fixture.paths, prepared.request))
      .rejects.toThrow(/credential.*missing/i);
  });
});

interface PrepareOptions {
  readonly persistGrant?: boolean;
  readonly operatorAuthority?: readonly ProviderAuthorityAtomV1[];
  readonly effectEntries?: readonly EffectPlanEntryV1[];
  readonly operatorBounds?: Partial<ProviderBoundsV1>;
  readonly operatorBrokerMaximums?: Partial<ProviderBrokerMaximumsV1>;
}

async function prepare(
  authority: readonly ProviderAuthorityAtomV1[], options: PrepareOptions = {},
): Promise<{ fixture: ResolutionFixture; request: EffectiveProviderGrantRequestV1 }> {
  const fixture = await installResolutionFixture(); fixtures.push(fixture);
  const projectRoot = path.join(fixture.root, "project"); await mkdir(projectRoot);
  const projectRealpathDigest = await projectGrantScopeDigest(projectRoot);
  const operatorGrant = scope(
    (options.operatorAuthority ?? authority).map(operatorize), 70, options.operatorBounds,
    options.operatorBrokerMaximums,
  );
  const confirmation = operatorGrantRequestDigest(fixture.pin, operatorGrant, projectRealpathDigest);
  if (options.persistGrant !== false) await writeOperatorGrant(fixture.paths, {
    grantId: "grant-one", projectRoot, providerPin: fixture.pin, grant: operatorGrant,
    confirmedGrantRequestDigest: confirmation, createdAt: "2026-07-18T12:00:00.000Z",
  });
  if (authority.some((atom) => atom.kind === "credential.use")) {
    await writeOperatorCredentialRegistry(fixture.paths, createCredentialRegistry([credentialHandle()]));
  }
  const effectEntries = options.effectEntries ?? authority.filter(isMutating).map(effectEntry);
  const priceTableDigest = hostPriceTableDigest(await readHostPriceTable(fixture.paths));
  return { fixture, request: {
    schemaVersion: 1, providerPin: fixture.pin, projectRealpathDigest,
    capabilityId: parseCapabilityId("discover"), workspaceId: "workspace-one",
    preparationRunId: "preparation-one", surface: "sdk", safetyFloorVersion: "floor-v1",
    hostFloor: scope(authority, 100), providerMaximum: scope(authority, 90),
    operationsPackRequest: scope(authority, 80), operatorGrantId: "grant-one",
    operatorGrantRevision: 1, operatorGrantRequestDigest: confirmation,
    effectPlan: { schemaVersion: 1, bounds: bounds(60), entries: effectEntries },
    priceTableDigest, resourceBounds: bounds(50), surfaceCap: bounds(40), exposureInputs: [],
  } };
}

function operatorize(atom: ProviderAuthorityAtomV1): ProviderAuthorityAtomV1 {
  return atom.kind === "credential.use" ? { ...atom, credentialHandleId: "credential-one" } : atom;
}
function isMutating(atom: ProviderAuthorityAtomV1): boolean { return atom.effectClass !== null; }
function effectEntry(atom: ProviderAuthorityAtomV1, index: number): EffectPlanEntryV1 {
  return {
    effectId: parseEffectId(`effect-${index}`), effectClass: atom.effectClass!, brokerId: atom.brokerId!,
    brokerContractVersion: "1.0.0", targetIdentity: atom.target!, requestDigest: digest("d"),
    idempotencyKey: `idempotency-${index}`, expectedBounds: { requests: 1 },
    requiredConfirmationClass: "operator", rollbackSemantics: "none", reversesEffectId: null,
  };
}
function credentialHandle(): CredentialHandleV1 {
  return { schemaVersion: 1, handleId: "credential-one", slotId: "api-token",
    source: { kind: "environment", variable: "LLMWIKI_TEST_PROVIDER_TASK5_SECRET" },
    allowedBrokerIds: [parseBrokerId("host-broker")], };
}
function scope(
  authority: readonly ProviderAuthorityAtomV1[], maximum: number,
  override?: Partial<ProviderBoundsV1>,
  brokerMaximums?: Partial<ProviderBrokerMaximumsV1>,
): ProviderGrantScopeV1 {
  return { schemaVersion: 1, authority, bounds: { ...bounds(maximum), ...override },
    ...(brokerMaximums === undefined ? {} : { brokerMaximums }) };
}
function authorityAtom(kind: (typeof KINDS)[number]): ProviderAuthorityAtomV1 {
  const brokerId = kind === "source.read" ? null : parseBrokerId("host-broker");
  const mutating = ["external.mutate", "scheduler.write", "email.send"].includes(kind);
  return {
    kind, brokerId, operation: kind === "source.read" ? "read" : "execute",
    target: ["source.read", "credential.use"].includes(kind) ? null : `target-${kind.replace(".", "-")}`,
    method: kind === "network.https" ? "POST" : null,
    credentialSlotId: kind === "credential.use" ? "api-token" : null,
    credentialHandleId: null, effectClass: mutating ? "write" : null,
    inputKind: kind === "source.read" ? "retained-source" : null,
    toolId: kind === "command.execute" ? "registered-tool" : null,
  };
}
function exposureInput(kind: string, byteCount: number) {
  return { inputId: "input-one", kind, provenanceLabel: "input one", mediaType: "text/plain",
    digest: digest("6"), byteCount, materializedToken: "input-one",
  } as EffectiveProviderGrantRequestV1["exposureInputs"][number];
}
function bounds(maximum: number): ProviderBoundsV1 {
  return { structuredInputBytes: maximum, materializedInputFiles: maximum,
    materializedInputBytes: maximum, scratchFiles: maximum, scratchBytes: maximum,
    outputFiles: maximum, outputBytes: maximum, custodyScanBytes: maximum,
    custodyWallTimeMs: maximum, protocolFrames: maximum, protocolBytes: maximum,
    brokerRequests: maximum, mutatingEffects: maximum, wallTimeMs: maximum,
    cpuTimeMs: maximum, memoryBytes: maximum, processCount: maximum };
}
function digest(character: string) { return parseSha256Digest(`sha256:${character.repeat(64)}`); }
