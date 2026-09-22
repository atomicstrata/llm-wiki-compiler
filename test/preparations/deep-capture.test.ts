/**
 * @file test/preparations/deep-capture.test.ts
 * @description Invariant coverage for the RC-A trust-boundary primitive. It proves
 * `deepCaptureData` produces a fresh, recursively-frozen, accessor-free tree that
 * shares no mutable reference with the caller, and that a sealed attempt context
 * is fully deep-frozen so a later mutation of the caller's original executor
 * changes nothing the leg receives or leg-K digests.
 */

import { describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { deepCaptureData, RuntimeCaptureError } from "../../src/utils/runtime-capture.js";
import { authoritySnapshotDigest, computeSealedAuthority, sealAttemptContext } from "../../src/preparations/attempts/start.js";

const D = parseSha256Digest(`sha256:${"a".repeat(64)}`);

/** Recursively assert a value is frozen with no accessor properties anywhere. */
function assertDeeplyFrozen(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;
  if (value instanceof Uint8Array) return; // JS cannot freeze typed-array elements; the copy is fresh
  if (!Object.isFrozen(value)) throw new Error(`not frozen at ${path}`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) throw new Error(`accessor at ${path}.${String(key)}`);
    assertDeeplyFrozen(descriptor.value, `${path}.${String(key)}`);
  }
}

const manifest = () => ({
  planDigest: D, plan: {
    knowledgeAuthority: { digest: D }, operationsAuthority: { digest: D },
    actionAuthority: { actionDescriptorDigest: D, handlerContractDigest: D }, recipeDigest: D, safetyFloorDigest: D,
  },
}) as never;
const executorLiteral = () => ({ kind: "provider-capability", providerPinDigest: D, capabilityId: "c", capabilityContractDigest: D });
const bounds = () => ({ maximumAttempts: 2, maximumInvocationsPerAttempt: 1, maximumBrokerRequestsPerAttempt: 0, maximumEffectsPerAttempt: 0, maximumTransitionsPerInstance: 4, maximumOutputEvidenceBytes: 1024, maximumCheckpointBytes: 0, maximumTokensPerAttempt: 0, maximumTimeMsPerInstance: 1000, maximumCostMicrosPerAttempt: 0 }) as never;

function seal(executor: unknown) {
  return sealAttemptContext({
    manifest: manifest(), executor: executor as never, bounds: bounds(), extras: { inputExposureSetDigest: D },
    attemptId: `pat_${"a".repeat(64)}` as never, phaseInstanceId: `phi_${"a".repeat(64)}` as never,
    logicalPhaseId: "collect", disposition: "required", lease: { pid: 1, leaseNonce: "n", acquiredAt: "t" }, stateVersionAtSeal: 1,
  });
}

describe("deepCaptureData", () => {
  it("copies typed-array bytes so a caller mutation cannot reach the capture", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const captured = deepCaptureData({ bytes }) as { bytes: Uint8Array };
    bytes[0] = 9;
    expect(captured.bytes[0]).toBe(1);
  });

  it("preserves a Buffer AS a Buffer, not as the widened Uint8Array", () => {
    // THE CAST EVERY CALLER MAKES IS ONLY HONEST IF THIS HOLDS. Callers write
    // `deepCaptureData(x) as T` where `T` has `Buffer` fields; returning the
    // widened type made those casts lies, and the failure is SILENT —
    // `toString("hex")` on a `Uint8Array` ignores the encoding and returns
    // comma-joined decimals rather than throwing. It also changes JSON shape,
    // which matters wherever a captured tree is serialized:
    // `{"0":1}` for a Uint8Array against `{"type":"Buffer","data":[1]}`.
    //
    // A type assertion is the right control precisely because the failure has
    // no exception to catch.
    const bytes = Buffer.from([1, 2, 3]);
    const captured = deepCaptureData({ bytes }) as { bytes: Uint8Array };
    expect(Buffer.isBuffer(captured.bytes)).toBe(true);
    // Still a copy, not the caller's instance.
    bytes[0] = 9;
    expect(captured.bytes[0]).toBe(1);
  });

  it("still widens a genuine Uint8Array rather than promoting it", () => {
    // ANTI-VACUITY for the case above: the rule is "preserve what you were
    // given", not "make everything a Buffer". A caller that supplied a plain
    // typed array must not get a Buffer back, or the preservation claim is
    // just a blanket conversion wearing a narrower name.
    const captured = deepCaptureData({ bytes: new Uint8Array([1, 2, 3]) }) as { bytes: Uint8Array };
    expect(captured.bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(captured.bytes)).toBe(false);
  });

  it("produces a recursively frozen, accessor-free tree", () => {
    const captured = deepCaptureData({ a: { b: [1, { c: "x" }] } });
    assertDeeplyFrozen(captured);
  });

  it("rejects accessors, functions, and proxies at any level", () => {
    const getter = {}; Object.defineProperty(getter, "x", { get: () => 1, enumerable: true });
    expect(() => deepCaptureData(getter)).toThrow(RuntimeCaptureError);
    expect(() => deepCaptureData({ f: () => 1 })).toThrow(RuntimeCaptureError);
    expect(() => deepCaptureData(new Proxy({}, {}))).toThrow(RuntimeCaptureError);
  });
});

describe("sealAttemptContext RC-A invariant", () => {
  it("returns a deeply frozen sealed context", () => {
    assertDeeplyFrozen(seal(executorLiteral()));
  });

  it("does not share the executor with the caller (mutation changes nothing)", () => {
    const executor = executorLiteral();
    const sealed = seal(executor);
    const before = sealed.authoritySnapshotDigest;
    executor.providerPinDigest = parseSha256Digest(`sha256:${"9".repeat(64)}`);
    expect((sealed.executor as { providerPinDigest: string }).providerPinDigest).toBe(D);
    const recomputed = authoritySnapshotDigest(computeSealedAuthority(manifest(), sealed.executor, { inputExposureSetDigest: D }));
    expect(recomputed).toBe(before);
  });
});

/** An object nested `depth` levels deep. */
function nested(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: 1 };
  for (let index = 0; index < depth; index += 1) node = { nested: node };
  return node;
}

describe("deepCaptureData bounds its own recursion", () => {
  /**
   * THE NODE BUDGET DOES NOT BOUND STACK DEPTH, and the two are independent:
   * 20,000 nested objects is 20,000 nodes, comfortably inside the 100,000-node
   * budget, and it overflowed the stack. A `RangeError` out of a fail-closed
   * primitive is a FAULT escaping a boundary whose contract is a typed refusal —
   * and every caller passes untrusted trees to it.
   *
   * The assertion is on the error TYPE, because "it threw" is satisfied by the
   * overflow this exists to prevent.
   */
  it("refuses a tree deeper than its bound instead of overflowing the stack", () => {
    expect(() => deepCaptureData(nested(20_000))).toThrow(RuntimeCaptureError);
  });

  it("still captures a tree within the bound", () => {
    expect(deepCaptureData(nested(8))).toEqual(nested(8));
  });
});

/**
 * WHERE THE UNBOUNDED RECURSION WAS ACTUALLY REACHABLE, measured rather than
 * counted from call sites.
 *
 * The primitive has ~20 callers and the natural assumption is that all of them
 * inherit the exposure. They do not, for two different reasons:
 *
 *  - `handoff`'s obligation capture sits behind `catch { return null; }`, which
 *    absorbs a `RangeError` exactly as it absorbs a typed refusal. A case there
 *    is green with or without the bound. (That it survives by catch-all is its
 *    own smell — a genuine fault reports as an incomplete obligation set.)
 *  - `sealAttemptContext` wraps nothing, but every field it captures is FLAT:
 *    a deep-but-otherwise-valid input is not constructible, and a deep one is
 *    rejected on shape before depth is ever consulted.
 *
 * The surfaces that were genuinely exposed are the two that accept FREE-FORM
 * caller inputs — `runAction` and `startWorkflow` — and both are pinned at their
 * own boundaries in `workflow-run-action-capture.test.ts`. This note exists so
 * the next reader does not re-derive the call-site count as a risk count.
 */
