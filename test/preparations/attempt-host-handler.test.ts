/**
 * @file test/preparations/attempt-host-handler.test.ts
 * @description Host-handler-leg contract (design section 15.4): the leg binds its
 * ref to the SEALED executor, enforces the SEALED phase resource ceilings,
 * resolves through the registry INTERFACE with the project lock released, and
 * commits the honest outcome. It fails closed when the ref does not match the
 * sealed executor, when requested bounds exceed the sealed phase or the
 * descriptor, or when the resolved descriptor does not bind the ref.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import { hostHandlerLegRunner, type HostHandlerLegInputV1 } from "../../src/preparations/attempts/host-handler.js";
import type { HostHandlerRefV1, PreparationHostHandlerRegistryV1 } from "../../src/preparations/attempts/types.js";
import {
  attemptRequest, EXPOSURE, fakeRegistry, fixedResolver, lockIsFree,
  phaseInstanceIdFor, PIN, stagePreparation, wideBounds, type StagedPreparation,
} from "./attempt-fixture.js";

const REF: HostHandlerRefV1 = { handlerId: "expander", handlerContractVersion: "1", handlerContractDigest: PIN };
const EXECUTOR = { kind: "host-handler", handlerId: "expander", handlerContractVersion: "1", handlerContractDigest: PIN };
const legCtx = (outputCap = 2 ** 31) => ({
  attemptId: "pat" as never, lease: { pid: 1, leaseNonce: "n", acquiredAt: "t" },
  sealed: { phaseInstanceId: "phi", executor: EXECUTOR, bounds: wideBounds(outputCap),
    authority: { inputExposureSetDigest: EXPOSURE } } as never,
});

let staged: StagedPreparation;
beforeEach(async () => { staged = await stagePreparation(); });
afterEach(() => staged.cleanup());

function legInput(overrides: Partial<HostHandlerLegInputV1> = {}): HostHandlerLegInputV1 {
  return {
    ref: REF, registry: fakeRegistry(), maximumOutputBytes: 1024, maximumWallTimeMs: 1000, ...overrides,
  };
}

function hostRequest(input: HostHandlerLegInputV1) {
  return attemptRequest(staged, {
    logicalPhaseId: "expand", phaseInstanceId: phaseInstanceIdFor(staged.binding, "expand"),
    authorityResolver: fixedResolver({ inputExposureSetDigest: EXPOSURE }), leg: hostHandlerLegRunner(input),
  });
}

describe("preparation attempt host-handler leg", () => {
  it("resolves and runs the handler with the project lock released and commits", async () => {
    let sawLockFree = false;
    const registry = fakeRegistry(async () => {
      sawLockFree = await lockIsFree(staged.root);
      return { kind: "completed", succeededWithWarnings: false, outputs: [] };
    });
    const outcome = await executePhaseAttempt(hostRequest(legInput({ registry })));
    expect(sawLockFree).toBe(true);
    expect(outcome.status).toBe("committed");
  });

  it("fails closed when the ref does not match the sealed executor", async () => {
    const drifted: HostHandlerRefV1 = { ...REF, handlerContractDigest: parseSha256Digest(`sha256:${"d".repeat(64)}`) };
    await expect(hostHandlerLegRunner(legInput({ ref: drifted }))(legCtx())).rejects.toThrow(/ref does not match the sealed executor/);
  });

  it("fails closed when requested bounds exceed the sealed phase bounds", async () => {
    await expect(hostHandlerLegRunner(legInput({ maximumOutputBytes: 2048 }))(legCtx(1024))).rejects.toThrow(/exceeds the sealed phase bounds/);
  });

  it("fails closed when the resolved descriptor does not bind the ref", async () => {
    const substituted: PreparationHostHandlerRegistryV1 = {
      resolve: () => ({
        handler: { execute: async () => ({ kind: "completed", succeededWithWarnings: false, outputs: [] }) },
        descriptor: { ...fakeRegistry().resolve(REF).descriptor, handlerContractDigest: parseSha256Digest(`sha256:${"c".repeat(64)}`) },
      }),
    };
    await expect(hostHandlerLegRunner(legInput({ registry: substituted }))(legCtx())).rejects.toThrow(/does not bind the sealed handler/);
  });

  it("fails closed when a host input field is an accessor (getter-swap)", () => {
    const input = legInput();
    Object.defineProperty(input, "maximumOutputBytes", { get: () => 1024, enumerable: true, configurable: true });
    expect(() => hostHandlerLegRunner(input)).toThrow();
  });

  it("commits the honest failed phase when the handler fails", async () => {
    const registry = fakeRegistry(async () => ({ kind: "failed", problem: "handler-error", detail: "x" }));
    const outcome = await executePhaseAttempt(hostRequest(legInput({ registry })));
    expect(outcome.status === "committed" && outcome.phaseState).toBe("failed");
  });
});
