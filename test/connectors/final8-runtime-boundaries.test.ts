/**
 * @file test/connectors/final8-runtime-boundaries.test.ts
 * @description Decision 17 regressions enforce constant-time text prefilters,
 * bounded one-line result reasons, and typed revoked-Proxy rejection.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureCandidateCustodyReceipts,
  CandidateCustodyBoundaryError,
} from "../../src/compiler/candidate-custody-snapshot.js";
import {
  captureConnectorCandidateIds,
  captureConnectorResult,
} from "../../src/connectors/candidate-batch.js";
import { captureConnectorIdentity } from "../../src/connectors/candidate-identity.js";
import { captureConnectorInputs } from "../../src/connectors/input-validation.js";
import { archiveCandidatesWithUndo } from "../../src/connectors/candidate-supersession.js";
import { captureDenseArray, RuntimeCaptureError } from "../../src/utils/runtime-capture.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { captureConnectorCommand } from "./connector-command-fixtures.js";

const root = useTempRoot();
const INVALID_RESULT = "connector returned invalid candidate identities";

/** Return a revoked Proxy whose target was an array. */
function revokedArray(): unknown {
  const pair = Proxy.revocable([], {});
  pair.revoke();
  return pair.proxy;
}

describe("Final8 connector runtime boundaries", () => {
  afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

  it("rejects over-limit connector text before Unicode scanning", () => {
    const overLimit = `${"x".repeat(513)}\ud800`;
    const scanner = vi.spyOn(String.prototype, "charCodeAt");

    const input = captureConnectorInputs(["id"], { id: overLimit });
    const identity = captureConnectorIdentity({
      id: "fixture", version: "1", canonicalSourceId: () => overLimit,
    }, {});
    const reason = () => captureConnectorResult({ kind: "refused", reason: overLimit });

    expect(input).toMatchObject({ kind: "refused" });
    expect(identity).toBeNull();
    expect(reason).toThrow(expect.objectContaining({ name: "ConnectorCandidateBoundaryError" }));
    expect(scanner).not.toHaveBeenCalled();
  });

  it("retains the exact accepted SDK reason in a frozen snapshot", () => {
    const result = captureConnectorResult({ kind: "refused", reason: "safe exact reason" });

    expect(result).toEqual({ kind: "refused", reason: "safe exact reason" });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("renders accepted hostile reason data on one escaped line", async () => {
    const reason = "first\n\u001b[2J\u202e\u200b,\\\"😀";

    const lines = await captureConnectorCommand(root.dir, { kind: "refused", reason });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(lines[0]).not.toContain("\u001b[2J");
    expect(lines[0]).not.toContain("\u202e");
    expect(lines[0]).not.toContain("😀");
    expect(lines[0]).toContain("\\u000a");
    expect(lines[0]).toContain("\\u001b");
    expect(lines[0]).toContain("\\u202e");
    expect(lines[0]).toContain("\\ud83d\\ude00");
  });

  it.each([
    ["empty", ""],
    ["lone surrogate", "bad\ud800"],
    ["cap plus one", "x".repeat(513)],
  ])("refuses an invalid injected %s reason with one fixed line", async (_name, reason) => {
    const lines = await captureConnectorCommand(root.dir, { kind: "unavailable", reason });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(INVALID_RESULT);
    expect(process.exitCode).toBe(1);
  });

  it("rejects a revoked Proxy before Array.isArray can throw", () => {
    expect(() => captureDenseArray(revokedArray(), 1, (item) => item))
      .toThrow(RuntimeCaptureError);
  });

  it("translates a revoked candidate array at the public result boundary", () => {
    expect(() => captureConnectorCandidateIds(revokedArray()))
      .toThrow(expect.objectContaining({ name: "ConnectorCandidateBoundaryError" }));
  });

  it("translates a revoked receipt array at the custody boundary", () => {
    expect(() => captureCandidateCustodyReceipts(revokedArray()))
      .toThrow(CandidateCustodyBoundaryError);
  });

  it("translates a revoked archive-entry array before effects", async () => {
    const archived = archiveCandidatesWithUndo(root.dir, revokedArray() as never);

    await expect(archived).rejects.toBeInstanceOf(CandidateCustodyBoundaryError);
  });
});
