/**
 * @file test/preparations/ephemeral-broker-surface.test.ts
 * @description The broker surface an invocation RUNS with is the one classified
 * against the sealed plan — not whatever the caller's object holds by the time
 * the provider starts. Both cases reproduce the TOCTOU the leg used to have: the
 * classification and the structural bound checks run synchronously, then custody
 * creation yields, and a key ADDED to the caller's broker object inside that
 * window reached invoke. Adding `https` widened a zero-broker phase's surface;
 * adding `model` corrupted usage honesty, since the stale classification lets the
 * leg report a "proven 0" token and cost for a model-capable invocation.
 */

import { describe, expect, it } from "bun:test";
import type { ProviderInvokeFn } from "../../src/preparations/attempts/provider.js";
import type { ProviderInvocationRequestV1 } from "../../src/capability-providers/runtime/invoke.js";
import type { AttemptAuthorityResolverV1 } from "../../src/preparations/attempts/types.js";
import { completedProviderInvoke, providerAuthority, providerRequest } from "./attempt-fixture.js";
import { ephemeralRequest, HOST, runFixtureRead, withEphemeralSandbox } from "./ephemeral-fixture.js";

/** A completed provider invocation reporting metered usage and no artifact. */
const succeeded = completedProviderInvoke([], { brokerRequestCount: 0, tokenCount: 4, costMicros: 2 });

/**
 * A resolver that arms the caller's broker mutation as an IMMEDIATE task. Every
 * step between the resolver and the leg's classification is a microtask, so the
 * task lands strictly AFTER classification — inside the custody-creation window
 * that separates the checks from invoke. An immediate rather than a zero timer:
 * a timer is not due for a millisecond, and custody creation can finish sooner.
 */
function armingResolver(
  brokers: Record<string, unknown>, adapterKey: string, landed: () => void,
): AttemptAuthorityResolverV1 {
  return {
    resolve: async () => {
      setImmediate(() => { brokers[adapterKey] = {}; landed(); });
      return { status: "ok", extras: providerAuthority() };
    },
  };
}

/** Run one read whose broker object gains `adapterKey` after classification. */
async function readWithLateAdapter(adapterKey: string) {
  const request = providerRequest();
  const brokers = request.brokers as unknown as Record<string, unknown>;
  let observed: readonly string[] | undefined;
  const mutation = Promise.withResolvers<void>();
  const invoke: ProviderInvokeFn = async (seen: ProviderInvocationRequestV1, host) => {
    // On a fast runner custody creation can finish before the task fires. Wait
    // for it, so a surface still shared with the caller's object shows the key.
    await mutation.promise;
    observed = Object.keys(seen.brokers);
    return succeeded(seen, host);
  };
  const run = await withEphemeralSandbox(() => runFixtureRead(ephemeralRequest({
    authorityResolver: armingResolver(brokers, adapterKey, mutation.resolve),
    work: { kind: "provider-capability", request, host: HOST },
  }), invoke));
  return { result: run.result, observed, callerKeys: Object.keys(brokers) };
}

describe("ephemeral broker surface reconstruction", () => {
  it("does not forward an https adapter added after classification", async () => {
    const run = await readWithLateAdapter("https");
    // The mutation must actually have landed, or the case proves nothing.
    expect(run.callerKeys).toEqual(["https"]);
    expect(run.result.status).toBe("completed");
    expect(run.observed).toEqual([]);
  });

  it("does not forward a model adapter added after classification", async () => {
    const run = await readWithLateAdapter("model");
    expect(run.callerKeys).toEqual(["model"]);
    expect(run.result.status).toBe("completed");
    expect(run.observed).toEqual([]);
    // No model adapter reached invoke, so the reported proven-zero usage is honest.
    if (run.result.status !== "completed") return;
    expect([run.result.tokenCount, run.result.costMicros]).toEqual([0, 0]);
  });
});
