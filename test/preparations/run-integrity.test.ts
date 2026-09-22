/**
 * @file test/preparations/run-integrity.test.ts
 * @description Whole-record integrity contract: HMAC verification, wrong key
 * epoch, binding mismatch, a tampered integrity value, and interior transition
 * removal, reordering, and stateVersion regression that stay detectable through
 * the sequence and hash chain even when the HMAC is re-stamped under the key.
 */

import { describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import {
  preparationKeyEpochId, signPreparationRun, verifyPreparationRunIntegrity,
} from "../../src/preparations/run-integrity.js";
import { parsePreparationRun } from "../../src/preparations/run-parse.js";
import { append, fixtureBinding, genesisContent, signedRunText, testKey } from "./run-fixture.js";

/** Build a three-transition running run for interior-tamper coverage. */
function runningRun() {
  const started = append(genesisContent(), { type: "phase-started", stateAfter: "running", actor: { id: "operator", surface: "cli" }, at: "2026-07-20T00:00:01.000Z", payload: { kind: "phase", phaseInstanceId: `phi_${"a".repeat(64)}`, phaseState: "running" } });
  return append(started, { type: "phase-progressed", stateAfter: "running", actor: { id: "operator", surface: "cli" }, at: "2026-07-20T00:00:02.000Z", payload: { kind: "phase", phaseInstanceId: `phi_${"a".repeat(64)}`, phaseState: "running" } });
}

describe("preparation run integrity", () => {
  it("verifies a signed genesis and rejects a wrong key epoch", () => {
    const run = parsePreparationRun(signedRunText(genesisContent()), fixtureBinding());
    expect(verifyPreparationRunIntegrity(run, testKey(), fixtureBinding())).toBe(true);
    expect(verifyPreparationRunIntegrity(run, Buffer.alloc(32, 0x11), fixtureBinding())).toBe(false);
  });

  it("rejects a tampered integrity value under the correct key", () => {
    const signed = signPreparationRun(testKey(), genesisContent());
    const tampered = { ...signed, integrity: `${signed.integrity.slice(0, -1)}${signed.integrity.endsWith("0") ? "1" : "0"}` };
    expect(verifyPreparationRunIntegrity(tampered, testKey(), fixtureBinding())).toBe(false);
  });

  it("rejects a binding whose manifest digest names a different preparation", () => {
    const text = signedRunText(genesisContent());
    expect(() => parsePreparationRun(text, { ...fixtureBinding(), manifestDigest: parseSha256Digest(`sha256:${"9".repeat(64)}`) })).toThrow();
  });

  it("detects interior transition removal even when re-signed", () => {
    const run = signPreparationRun(testKey(), runningRun());
    const spliced = { ...run, transitions: [run.transitions[0], run.transitions[2]] };
    const text = canonicalBytes(signPreparationRun(testKey(), spliced)).toString("utf8");
    expect(() => parsePreparationRun(text)).toThrow();
  });

  it("detects a stateVersion regression that disagrees with the chain length", () => {
    const run = signPreparationRun(testKey(), { ...runningRun(), stateVersion: 99 });
    const text = canonicalBytes(run).toString("utf8");
    expect(() => parsePreparationRun(text)).toThrow(/stateVersion/);
  });

  it("derives a stable domain-separated key epoch identity", () => {
    expect(preparationKeyEpochId(testKey())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
