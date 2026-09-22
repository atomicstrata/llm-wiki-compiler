/**
 * @file test/capability-providers/broker-deadline.test.ts
 * @description Host wall-time deadline enforcement across broker dispatch: a
 * read-only broker past the deadline is unavailable, a mutating effect past the
 * deadline before transmission is refused without external contact, and a
 * mutating effect whose deadline fires after transmission settles as
 * outcome-unknown rather than a retryable failure.
 */
import { describe, expect, it, vi } from "vitest";
import { parseInvocationId } from "../../src/capability-providers/ids.js";
import type { HostMutationExecutorV1 } from "../../src/capability-providers/brokers/remote-effect.js";
import type { HostRepositoryBrokerV1 } from "../../src/capability-providers/brokers/repository.js";
import {
  createHostBrokerDispatcher, dispatchHostBrokerRequest,
} from "../../src/capability-providers/brokers/dispatch.js";
import {
  useBrokerFixtures, prepareBrokerAuthority, plannedEffect, effectStateAuthority,
  brokerEnvelope, brokerEffectId, brokerAtom,
} from "./broker-fixture.js";

const trackFixture = useBrokerFixtures();
const COMMIT = "a".repeat(40);
const EFFECT_ID = brokerEffectId("invocation-deadline", 0);

/** A budget far larger than any timer this test could plausibly let fire. */
const BUDGET_MS = 50_000;

/** A monotonic clock this test moves by hand, so no assertion waits on a timer. */
function advanceableClock(): { now: () => number; advance: (ms: number) => void } {
  let elapsed = 0;
  return { now: () => elapsed, advance: (ms) => { elapsed += ms; } };
}

describe("broker wall-time deadline", () => {
  it("reports a read-only broker unavailable past the deadline before adapter I/O", async () => {
    const snapshot = vi.fn();
    const { dispatcher, request } = await readOnlyDispatcher(snapshot, AbortSignal.abort());
    const result = await dispatchHostBrokerRequest(dispatcher, request);
    expect(result.status).toBe("unavailable");
    expect(snapshot).not.toHaveBeenCalled();
  });

  /**
   * THE CASE THIS FILE EXISTS FOR, and the one that used to be timing-dependent.
   *
   * The budget is a generous 50s and the clock is advanced past it by hand, so
   * `AbortSignal.timeout(50_000)` has certainly NOT fired: the signal reports
   * "not aborted" while the wall-time bound is unambiguously spent. Gating on
   * the signal — as every broker did — lets the adapter run. Gating on the
   * clock refuses it.
   *
   * The previous shape asked for a 0ms budget and slept 1ms, hoping the timer
   * callback had been scheduled. Under a loaded runner it often had not, and the
   * resulting failure was read as flakiness for months. Sleeping longer would
   * have hidden the defect; the sleep was never the problem.
   */
  it("refuses adapter I/O once the monotonic budget is spent, though the signal has not fired", async () => {
    const snapshot = vi.fn();
    const injected = new AbortController().signal;
    const clock = advanceableClock();
    const { dispatcher, request } = await readOnlyDispatcher(
      snapshot, injected, { operator: { wallTimeMs: BUDGET_MS } }, clock.now);
    clock.advance(BUDGET_MS + 1);

    expect(injected.aborted).toBe(false);
    const result = await dispatchHostBrokerRequest(dispatcher, request);
    expect(result.status).toBe("unavailable");
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("admits adapter I/O while the monotonic budget still has room", async () => {
    const snapshot = vi.fn(async () => { throw new Error("adapter reached"); });
    const clock = advanceableClock();
    const { dispatcher, request } = await readOnlyDispatcher(
      snapshot, new AbortController().signal, { operator: { wallTimeMs: BUDGET_MS } }, clock.now);
    clock.advance(BUDGET_MS - 1);

    // The GREEN half of the boundary: without it, a deadline that always
    // reports "spent" would satisfy the case above and refuse everything.
    await dispatchHostBrokerRequest(dispatcher, request);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  /**
   * ISOLATES THE CENTRAL DISPATCH GATE. The `remote-effect` broker has no
   * deadline check of its own, so nothing downstream can cover for dispatch
   * here. That matters because the read-only case above cannot tell the two
   * layers apart: reverting either the dispatch gate or the repository gate on
   * its own leaves it green, and only reverting BOTH turns it red. A redundancy
   * no case can separate is a layer that can be removed silently.
   */
  it("refuses a mutating effect once the monotonic budget is spent, though the signal has not fired", async () => {
    const execute = vi.fn(async () => ({ outcome: "applied" as const }));
    const clock = advanceableClock();
    const { dispatcher, request } = await mutatingDispatcher(
      execute, new AbortController().signal, clock.now, BUDGET_MS);
    clock.advance(BUDGET_MS + 1);

    const result = await dispatchHostBrokerRequest(dispatcher, request);
    expect(result.status).toBe("refused");
    expect(execute).not.toHaveBeenCalled();
  });

  /**
   * THE INTERVAL AFTER THE CENTRAL GATE. Dispatch checks the deadline, then
   * awaits the settled-effect lookup, the credential read, and the durable
   * effect claim before any adapter runs. The clock is advanced INSIDE the
   * claim, so the budget is spent in exactly that interval: the gate passed
   * honestly and the effect must still not be transmitted.
   *
   * This is why the per-broker gate is not merely defence in depth. It closes
   * time that dispatch cannot account for, because dispatch has already run.
   */
  it("refuses a mutating effect whose budget is spent between the central gate and the adapter", async () => {
    const execute = vi.fn(async () => ({ outcome: "applied" as const }));
    const clock = advanceableClock();
    const effectState = effectStateAuthority();
    const claimStarted = effectState.claimStarted.bind(effectState);
    const spendingEffectState = {
      ...effectState,
      claimStarted: async (effectId: string) => {
        const claimed = await claimStarted(effectId);
        clock.advance(BUDGET_MS + 1);
        return claimed;
      },
    };
    const { dispatcher, request } = await mutatingDispatcher(
      execute, new AbortController().signal, clock.now, BUDGET_MS, spendingEffectState);

    const result = await dispatchHostBrokerRequest(dispatcher, request);
    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe("refused");
  });

  it("refuses a mutating effect past the deadline before any transmission", async () => {
    const execute = vi.fn(async () => ({ outcome: "applied" as const }));
    const { dispatcher, request } = await mutatingDispatcher(execute, AbortSignal.abort());
    const result = await dispatchHostBrokerRequest(dispatcher, request);
    expect(result.status).toBe("refused");
    expect(result.receipt).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("settles a mutating effect as outcome-unknown when the deadline fires after transmission", async () => {
    const controller = new AbortController();
    const execute = vi.fn((request: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
    }));
    const { dispatcher, request } = await mutatingDispatcher(execute, controller.signal);
    const pending = dispatchHostBrokerRequest(dispatcher, request);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    controller.abort();
    const result = await pending;
    expect(result.status).toBe("outcome-unknown");
    expect(result.receipt).toMatchObject({ outcome: "outcome-unknown", effectClass: "deployment" });
  });
});

async function mutatingDispatcher(
  execute: HostMutationExecutorV1, deadlineSignal: AbortSignal,
  monotonicNowMs?: () => number, wallTimeMs?: number,
  effectState?: ReturnType<typeof effectStateAuthority>,
) {
  const request = brokerEnvelope("remote-effect", {
    operation: "deploy-release", parameters: { release: "v1" },
  }, EFFECT_ID);
  const authority = [brokerAtom({ kind: "external.mutate", brokerId: "remote-effect",
    operation: "deploy-release", target: "production", effectClass: "deployment" })];
  const operation = { operationId: "deploy-release", targetIdentity: "production",
    effectClass: "deployment",
    parameters: [{ name: "release", type: "string" as const, maxStringBytes: 32 }] };
  const effects = [plannedEffect(request, "deployment", "production", EFFECT_ID, operation)];
  const boundOverrides = wallTimeMs === undefined ? undefined : { operator: { wallTimeMs } };
  const fixture = trackFixture(await prepareBrokerAuthority({ authority, effects, boundOverrides }));
  const dispatcher = await createHostBrokerDispatcher({
    paths: fixture.package.paths, authorityRequest: fixture.request,
    invocationId: parseInvocationId("invocation-deadline"),
    brokers: { "remote-effect": { operations: [operation], execute } },
    effectState: effectState ?? effectStateAuthority(), deadlineSignal, monotonicNowMs,
  });
  return { dispatcher, request };
}

async function readOnlyDispatcher(
  snapshot: HostRepositoryBrokerV1["snapshot"], deadlineSignal: AbortSignal,
  boundOverrides?: Parameters<typeof prepareBrokerAuthority>[0]["boundOverrides"],
  monotonicNowMs?: () => number,
) {
  const authority = [brokerAtom({ kind: "repository.snapshot", brokerId: "repository",
    operation: "snapshot-main", target: "https://git.example/repo.git" })];
  const fixture = trackFixture(await prepareBrokerAuthority({ authority, boundOverrides }));
  const broker = { operations: [{ operationId: "snapshot-main",
    remoteIdentity: "https://git.example/repo.git", commit: COMMIT, maxObjectBytes: 100,
    maxCheckoutBytes: 100, maxFiles: 10, pathPrefixes: ["src/"],
    submodules: "forbid" as const, lfs: "forbid" as const }], snapshot };
  const dispatcher = await createHostBrokerDispatcher({
    paths: fixture.package.paths, authorityRequest: fixture.request,
    invocationId: parseInvocationId("invocation-deadline"),
    brokers: { repository: broker }, deadlineSignal, monotonicNowMs,
  });
  return { dispatcher, request: brokerEnvelope("repository", { operation: "snapshot-main", commit: COMMIT }) };
}
