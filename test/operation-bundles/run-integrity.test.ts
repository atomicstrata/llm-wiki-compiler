/**
 * @file test/operation-bundles/run-integrity.test.ts
 * @description HMAC, epoch binding, constant-time comparison, and transition
 * chain tamper tests for operation-run authority records.
 */

import { describe, expect, it } from "vitest";
import { mintBundleId, mintOperationRunId } from "../../src/operation-bundles/ids.js";
import { parseOperationRun } from "../../src/operation-bundles/run-parse.js";
import {
  appendOperationTransition,
  operationRunIntegrityMatches,
  signOperationRun,
  verifyOperationRunIntegrity,
} from "../../src/operation-bundles/run-integrity.js";
import type { OperationPrincipal } from "../../src/operation-bundles/principal.js";
import type { OperationRunBinding } from "../../src/operation-bundles/run-types.js";
import { runFixture } from "./run-fixture.js";

const KEY = Buffer.alloc(32, 11);
const OTHER_KEY = Buffer.alloc(32, 12);
const ACTOR: OperationPrincipal = { id: "operator", surface: "cli", grants: [] };
const AT = "2026-07-17T01:00:00.000Z";
const DIGEST = `sha256:${"d".repeat(64)}` as const;
const OWNER = { pid: 77, processStartTime: AT };

/** Create one signed applying run for integrity-tamper tests. */
function fixture() {
  const base = runFixture({ key: KEY, actor: ACTOR, at: AT, workspaceId: "integrity" });
  let content = appendOperationTransition(base.content, { type: "approved", stateAfter: "approved", payload: { kind: "authority", authoritySnapshotDigest: DIGEST }, actor: ACTOR, at: AT });
  content = appendOperationTransition(content, { type: "apply-started", stateAfter: "applying", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER }, actor: ACTOR, at: AT });
  const { binding } = base;
  return { content, binding, signed: signOperationRun(KEY, content) };
}

describe("operation run integrity", () => {
  it("accepts the whole-record HMAC only under its bound key and record", () => {
    const { signed, binding } = fixture();
    expect(verifyOperationRunIntegrity(signed, KEY, binding)).toBe(true);
    expect(verifyOperationRunIntegrity(signed, OTHER_KEY, binding)).toBe(false);
    expect(operationRunIntegrityMatches(signed.integrity, signed.integrity)).toBe(true);
    expect(operationRunIntegrityMatches("not-hex", signed.integrity)).toBe(false);
  });

  it("rejects a whole-file edit under the original HMAC", () => {
    const { signed, binding } = fixture();
    const edited = { ...signed, notices: [{ code: "cancellation-overridden" }] };
    expect(verifyOperationRunIntegrity(edited, KEY, binding)).toBe(false);
  });

  it("rejects a record re-signed by a key from the wrong epoch", () => {
    const { content, binding } = fixture();
    const foreign = signOperationRun(OTHER_KEY, content);
    expect(verifyOperationRunIntegrity(foreign, OTHER_KEY, binding)).toBe(false);
  });

  it("rejects removed transitions even when the edited file is re-signed", () => {
    const { content, binding } = fixture();
    const removed = { ...content, transitions: [content.transitions[0], content.transitions[2]] };
    const signed = signOperationRun(KEY, removed);
    expect(() => parseOperationRun(JSON.stringify(signed), binding)).toThrow(/sequence|chain|stateVersion/);
  });

  it("rejects reordered transitions even when the edited file is re-signed", () => {
    const { content, binding } = fixture();
    const [first, second, third] = content.transitions;
    const reordered = { ...content, transitions: [first, third, second] };
    const signed = signOperationRun(KEY, reordered);
    expect(() => parseOperationRun(JSON.stringify(signed), binding)).toThrow(/sequence|chain|state/);
  });

  it("rejects each foreign manifest, run, workspace, bundle, and epoch binding", () => {
    const { signed, binding } = fixture();
    const wrong: OperationRunBinding[] = [
      { ...binding, manifestDigest: `sha256:${"e".repeat(64)}` },
      { ...binding, runId: mintOperationRunId() },
      { ...binding, workspaceId: "foreign" },
      { ...binding, bundleId: mintBundleId() },
      { ...binding, keyEpochId: `sha256:${"f".repeat(64)}` },
    ];
    for (const expected of wrong) expect(verifyOperationRunIntegrity(signed, KEY, expected)).toBe(false);
  });
});
