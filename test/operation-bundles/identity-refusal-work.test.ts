/**
 * @file test/operation-bundles/identity-refusal-work.test.ts
 * @description Operation identity refusals are fixed, nonreflecting, and reject
 * oversized values before any whole-input scanner or measurement primitive.
 */

import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { CandidateIdentityMismatchError } from "../../src/compiler/candidates.js";
import {
  assertBundleId,
  assertOperationRunId,
  compensationId,
  mutationId,
  type BundleId,
  type MutationId,
} from "../../src/operation-bundles/ids.js";
import { assertWorkspaceId, operationPaths } from "../../src/operation-bundles/paths.js";
import { OperationIdentityError } from "../../src/operation-bundles/problems.js";

const SECRET_SENTINEL = "OPERATION_IDENTITY_SECRET_SENTINEL";
const HOSTILE_CONTROLS = "\u0000\u0085\u200b\u2028\u2029\u202e\u2066";
const SAFE_SCAN_LIMIT = 256;

interface WorkObservations {
  readonly byteLength: number[];
  readonly normalize: number[];
  readonly regex: number[];
  readonly startsWith: number[];
}

/** Execute `action` while recording the input lengths seen by scanning primitives. */
function observeIdentityWork(action: () => void): WorkObservations {
  const observed: WorkObservations = { byteLength: [], normalize: [], regex: [], startsWith: [] };
  const byteLength = Buffer.byteLength.bind(Buffer);
  const normalize = String.prototype.normalize;
  const regexTest = RegExp.prototype.test;
  const startsWith = String.prototype.startsWith;
  vi.spyOn(Buffer, "byteLength").mockImplementation(((value: unknown, encoding?: BufferEncoding) => {
    if (typeof value === "string") observed.byteLength.push(value.length);
    return byteLength(value as string, encoding);
  }) as typeof Buffer.byteLength);
  vi.spyOn(String.prototype, "normalize").mockImplementation(function (this: string, form?: string) {
    observed.normalize.push(this.length);
    return normalize.call(this, form as "NFC");
  });
  vi.spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, value: string) {
    if (typeof value === "string") observed.regex.push(value.length);
    return regexTest.call(this, value);
  });
  vi.spyOn(String.prototype, "startsWith").mockImplementation(function (this: string, search, position) {
    observed.startsWith.push(this.length);
    return startsWith.call(this, search, position);
  });
  try { action(); } finally { vi.restoreAllMocks(); }
  return observed;
}

/** Assert every observed scanner input was bounded independently of the hostile value. */
function expectBoundedWork(observed: WorkObservations): void {
  for (const lengths of Object.values(observed)) {
    expect(lengths.every((length: number) => length <= SAFE_SCAN_LIMIT)).toBe(true);
  }
}

/** Assert one operation action rejects through the fixed typed boundary. */
function expectFixedOperationRefusal(action: () => unknown): Error {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(OperationIdentityError);
  expectNonreflectingMessage(caught as Error);
  return caught as Error;
}

/** Assert one fixed error message has no attacker-controlled presentation bytes. */
function expectNonreflectingMessage(error: Error): void {
  expect(error.message).not.toContain(SECRET_SENTINEL);
  expect(error.message).not.toContain("/private/project-path");
  expect(error.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
}

describe("nonreflecting Task 1 identity refusals", () => {
  it("removes caller previews from candidate identity mismatch errors", () => {
    const hostile = `/private/project-path/${HOSTILE_CONTROLS}${SECRET_SENTINEL}`;
    const error = new CandidateIdentityMismatchError(hostile, hostile);

    expectNonreflectingMessage(error);
  });

  it("uses a closed host-owned operation kind without reflecting either argument", () => {
    const hostile = `/private/project-path/${HOSTILE_CONTROLS}${SECRET_SENTINEL}`;
    const Constructor = OperationIdentityError as unknown as new (kind: unknown, value: unknown) => Error;
    const error = new Constructor(hostile, hostile);

    expectNonreflectingMessage(error);
  });

  it("does not reflect controls, paths, or secrets from ordinary invalid values", () => {
    const hostile = `workspace${HOSTILE_CONTROLS}/private/project-path/${SECRET_SENTINEL}`;
    const paths = operationPaths("/project", "workspace-a");

    expectFixedOperationRefusal(() => assertWorkspaceId(hostile));
    expectFixedOperationRefusal(() => paths.projectionRoot(hostile));
    expectFixedOperationRefusal(() => paths.sourceFile(hostile));
  });
});

describe("bounded-work operation identity refusals", () => {
  it("prefilters every huge identity before whole-input work", () => {
    const huge = `${"a".repeat(100_000)}${SECRET_SENTINEL}`;
    const paths = operationPaths("/project", "workspace-a");
    const actions = [
      () => assertBundleId(huge),
      () => assertOperationRunId(huge),
      () => mutationId(huge as BundleId, 0),
      () => compensationId(huge as MutationId),
      () => assertWorkspaceId(huge),
      () => paths.projectionRoot(huge),
      () => paths.sourceFile(huge),
    ];

    const observed = observeIdentityWork(() => {
      for (const action of actions) expectFixedOperationRefusal(action);
    });

    expectBoundedWork(observed);
  });

  it("rejects a revoked proxy without invoking caller hooks", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    const paths = operationPaths("/project", "workspace-a");
    revoke();

    expectFixedOperationRefusal(() => assertBundleId(proxy));
    expectFixedOperationRefusal(() => assertWorkspaceId(proxy));
    expectFixedOperationRefusal(() => paths.sourceFile(proxy as unknown as string));
  });
});
