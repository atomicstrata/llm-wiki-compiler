/**
 * @file test/capability-providers/remote-effect-broker.test.ts
 * @description Remote-effect tests for canonical captured request binding,
 * crash-window outcome-unknown receipts, and no blind retry while post-state
 * remains unresolved.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createHostBrokerDispatcher, dispatchHostBrokerRequest,
} from "../../src/capability-providers/brokers/dispatch.js";
import type { HostEffectStateAuthorityV1 } from "../../src/capability-providers/brokers/dispatch.js";
import type { HostMutationExecutorV1 } from "../../src/capability-providers/brokers/remote-effect.js";
import { parseInvocationId, parseSha256Digest } from "../../src/capability-providers/ids.js";
import {
  brokerAtom, brokerEffectId, brokerEnvelope, plannedEffect, prepareBrokerAuthority,
  effectStateAuthority, useBrokerFixtures,
} from "./broker-fixture.js";

const trackFixture = useBrokerFixtures();
const EFFECT_ID = brokerEffectId("invocation-deploy");

describe("remote-effect broker", () => {
  it("allows one atomic claim winner across racing dispatchers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => { await gate; return { outcome: "applied" as const }; });
    const { dispatcher, request, createDispatcher } = await setup(execute);
    const competing = await createDispatcher();
    const first = dispatchHostBrokerRequest(dispatcher, request);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await expect(dispatchHostBrokerRequest(competing, request)).rejects.toThrow(/effect.*started/i);
    release();
    await expect(first).resolves.toMatchObject({ status: "ok" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed claim result and preserves its durable poison", async () => {
    const durable = effectStateAuthority();
    const effectState = { ...durable, claimStarted: async (...args: Parameters<typeof durable.claimStarted>) => {
      const result = await durable.claimStarted(...args);
      return { ...result, unexpected: true };
    } };
    const execute = vi.fn(async () => ({ outcome: "applied" as const }));
    await expectEffectStateFailure(
      execute, effectState, /invalid claim result/i, /invalid claim result|started/i, 0,
    );
  });

  it("propagates claim persistence failure and refuses a fresh dispatcher", async () => {
    const durable = effectStateAuthority();
    let fail = true;
    const effectState = { ...durable, claimStarted: async (...args: Parameters<typeof durable.claimStarted>) => {
      const result = await durable.claimStarted(...args);
      if (fail) { fail = false; throw new Error("claim persistence failed"); }
      return result;
    } };
    const execute = vi.fn(async () => ({ outcome: "applied" as const }));
    await expectEffectStateFailure(
      execute, effectState, /claim persistence failed/i, /started/i, 0,
    );
  });

  it("propagates settlement failure and leaves the started claim parked", async () => {
    const durable = effectStateAuthority();
    const effectState = { ...durable, settle: async () => { throw new Error("settlement failed"); } };
    const execute = vi.fn(async () => ({ outcome: "applied" as const }));
    await expectEffectStateFailure(execute, effectState, /settlement failed/i, /started/i, 1);
  });

  it("mints outcome-unknown after an ambiguous crash and blocks blind retry", async () => {
    const execute = vi.fn(async () => { throw new Error("socket closed after write"); });
    const { dispatcher, request, createDispatcher } = await setup(execute);
    const first = await dispatchHostBrokerRequest(dispatcher, request);
    expect(first).toMatchObject({ status: "outcome-unknown", receipt: {
      outcome: "outcome-unknown", effectId: EFFECT_ID,
      sensitiveFieldsOmitted: true,
    } });
    const retryDispatcher = await createDispatcher();
    await expect(dispatchHostBrokerRequest(retryDispatcher, request))
      .rejects.toThrow(/effect.*unresolved|outcome.*unknown/i);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects payload drift against the captured approved request digest", async () => {
    const execute = vi.fn(async () => ({ outcome: "applied" as const }));
    const { dispatcher } = await setup(execute);
    const drifted = brokerEnvelope("remote-effect", {
      operation: "deploy-release", parameters: { release: "v2" },
    }, EFFECT_ID);
    await expect(dispatchHostBrokerRequest(dispatcher, drifted))
      .rejects.toThrow(/effect.*approved/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("mints applied receipts only from host-observed adapter facts", async () => {
    const execute = vi.fn(async () => ({
      outcome: "applied" as const, observedExternalIdentity: "deployment-42",
      responseDigest: digest("9"), output: { deploymentId: "deployment-42" },
    }));
    const { dispatcher, request, effect } = await setup(execute);
    const result = await dispatchHostBrokerRequest(dispatcher, request);
    expect(result.receipt).toMatchObject({
      outcome: "applied", observedExternalIdentity: "deployment-42",
      responseDigest: digest("9"), requestDigest: effect.requestDigest,
    });
    expect(result.receipt).not.toHaveProperty("deploymentId");
  });

  it("fails closed before mutation without host effect-state authority", async () => {
    const execute = vi.fn(async () => ({ outcome: "applied" as const }));
    const { dispatcher, request } = await setup(execute, { withAuthority: false });
    await expect(dispatchHostBrokerRequest(dispatcher, request))
      .rejects.toThrow(/effect-state authority/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("maps a hostile mutating ok observation to recorded outcome-unknown", async () => {
    // Deliberately violate the adapter result contract to exercise runtime refusal.
    const execute = vi.fn(async () => ({ outcome: "ok" as never }));
    const { dispatcher, request, createDispatcher } = await setup(execute);
    const result = await dispatchHostBrokerRequest(dispatcher, request);
    expect(result).toMatchObject({ status: "outcome-unknown", receipt: {
      outcome: "outcome-unknown",
    } });
    const retryDispatcher = await createDispatcher();
    await expect(dispatchHostBrokerRequest(retryDispatcher, request)).rejects.toThrow(/unresolved/i);
  });

  it("preserves an unknown receipt when the completion clock becomes invalid", async () => {
    const now = vi.fn()
      .mockReturnValueOnce(new Date("2026-07-18T12:00:00.000Z"))
      .mockReturnValueOnce(new Date(Number.NaN));
    const execute = vi.fn(async () => ({ outcome: "applied" as const }));
    const { dispatcher, request } = await setup(execute, { now });
    const result = await dispatchHostBrokerRequest(dispatcher, request);
    expect(result).toMatchObject({ status: "outcome-unknown", receipt: {
      outcome: "outcome-unknown", startedAt: "2026-07-18T12:00:00.000Z",
    } });
    expect(result.receipt).not.toHaveProperty("completedAt");
  });

  it("omits reflected optional receipt identity evidence", async () => {
    process.env.LLMWIKI_TEST_PROVIDER_TASK6_SECRET = "receipt-secret";
    try {
      const execute = vi.fn(async () => ({
        outcome: "applied" as const, observedExternalIdentity: "receipt-secret",
      }));
      const { dispatcher, request } = await setup(execute, { withCredential: true });
      const result = await dispatchHostBrokerRequest(dispatcher, request);
      expect(result.status).toBe("refused");
      expect(result.receipt).not.toHaveProperty("observedExternalIdentity");
      expect(JSON.stringify(result)).not.toContain("receipt-secret");
    } finally { delete process.env.LLMWIKI_TEST_PROVIDER_TASK6_SECRET; }
  });
});

async function expectEffectStateFailure(
  execute: ReturnType<typeof vi.fn>, effectState: HostEffectStateAuthorityV1,
  firstError: RegExp, freshError: RegExp, expectedCalls: number,
): Promise<void> {
  const { dispatcher, request, createDispatcher } = await setup(execute, { effectState });
  await expect(dispatchHostBrokerRequest(dispatcher, request)).rejects.toThrow(firstError);
  await expect(dispatchHostBrokerRequest(await createDispatcher(), request)).rejects.toThrow(freshError);
  expect(execute).toHaveBeenCalledTimes(expectedCalls);
}

async function setup(
  execute: HostMutationExecutorV1, options: SetupOptions = {},
) {
  const request = brokerEnvelope("remote-effect", {
    operation: "deploy-release", parameters: { release: "v1" },
  }, EFFECT_ID);
  const authority = [brokerAtom({
    kind: "external.mutate", brokerId: "remote-effect", operation: "deploy-release",
    target: "production", effectClass: "deployment",
  })];
  if (options.withCredential) authority.push(brokerAtom({
    kind: "credential.use", brokerId: "remote-effect", operation: "deploy-release",
    credentialSlotId: "deploy-token",
  }));
  const operation = { operationId: "deploy-release",
    targetIdentity: "production", effectClass: "deployment",
    parameters: [{ name: "release", type: "string" as const, maxStringBytes: 32 }],
    ...(options.withCredential ? { credentialSlotId: "deploy-token" } : {}) };
  const effects = [plannedEffect(
    request, "deployment", "production", EFFECT_ID, operation,
  )];
  const fixture = trackFixture(await prepareBrokerAuthority({ authority, effects }));
  const effectState = options.effectState ?? effectStateAuthority();
  const brokers = {
      "remote-effect": { operations: [operation], execute },
  };
  const createDispatcher = () => createHostBrokerDispatcher({
    paths: fixture.package.paths, authorityRequest: fixture.request,
    invocationId: parseInvocationId("invocation-deploy"), brokers,
    ...(options.now ? { now: options.now } : {}),
    ...(options.withAuthority === false ? {} : { effectState }),
  });
  return { dispatcher: await createDispatcher(), createDispatcher, request, effect: effects[0] };
}

interface SetupOptions {
  readonly withAuthority?: boolean;
  readonly now?: () => Date;
  readonly withCredential?: boolean;
  readonly effectState?: HostEffectStateAuthorityV1;
}

function digest(character: string) {
  return parseSha256Digest(`sha256:${character.repeat(64)}`);
}
