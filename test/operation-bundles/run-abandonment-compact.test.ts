/**
 * @file test/operation-bundles/run-abandonment-compact.test.ts
 * @description Regression proofs that abandonment binds detailed top-level
 * residual observations through one compact transition payload at full launch
 * scale, including the exact zero-unresolved case.
 */

import { describe, expect, it } from "vitest";
import { canonicalBytes, canonicalDigest } from "../../src/profile/templates/signing/canonical.js";
import { MAX_TRANSITION_ENVELOPE_BYTES } from "../../src/operation-bundles/constants.js";
import { appendOperationTransition, signOperationRun } from "../../src/operation-bundles/run-integrity.js";
import { parseOperationRun } from "../../src/operation-bundles/run-parse.js";
import type { OperationPrincipal } from "../../src/operation-bundles/principal.js";
import type { OperationRunContent, ResidualFinding } from "../../src/operation-bundles/run-types.js";
import type { OperationDigest } from "../../src/operation-bundles/types.js";
import { runFixture } from "./run-fixture.js";

const KEY = Buffer.alloc(32, 71);
const AT = "2026-07-18T01:00:00.000Z";
const ACTOR: OperationPrincipal = { id: "operator", surface: "cli", grants: ["operation-bundle.abandon"] };
const EVIDENCE = { digest: `sha256:${"a".repeat(64)}` as OperationDigest, byteCount: 1, type: "observation", provenance: "controller" };

/** Compute the canonical compact binding expected in the terminal transition. */
function findingDigest(findings: readonly ResidualFinding[]): OperationDigest {
  return canonicalDigest({ schemaVersion: 1, kind: "operation-run-residual-findings", findings }) as OperationDigest;
}

/** Park one run without changing its manifest-derived work projection. */
function park(run: OperationRunContent): OperationRunContent {
  return appendOperationTransition(run, {
    type: "recovery-required", stateAfter: "recovery-required", actor: ACTOR, at: AT,
    payload: { kind: "problem", code: "bundle-recovery-required" },
  });
}

/** Append compact abandonment while supplying detailed findings out of band. */
function abandon(run: OperationRunContent, findings: readonly ResidualFinding[]): OperationRunContent {
  return appendOperationTransition(run, {
    type: "abandoned", stateAfter: "abandoned", actor: ACTOR, at: AT, residualFindings: findings,
    payload: {
      kind: "abandonment", confirmation: "confirm-residual-state",
      findingCount: findings.length, findingsDigest: findingDigest(findings),
    },
  });
}

/** Build one detailed observation for a manifest-owned retained source. */
function residual(mutationId: ResidualFinding["mutationId"]): ResidualFinding {
  return { code: "residual", mutationId, authoritativeNamespace: "workspace-sources", evidence: EVIDENCE };
}

describe("compact abandonment binding", () => {
  it("settles all 256 launch identities within the 2 KiB transition cap", () => {
    const base = runFixture({ key: KEY, actor: ACTOR, at: AT, authoritativeMutationCount: 256 });
    const findings = base.content.obligations.authoritativeMutationIds.map(residual);
    const terminal = abandon(park(base.content), findings);
    const parsed = parseOperationRun(JSON.stringify(signOperationRun(KEY, terminal)), base.binding);
    expect(parsed.residualFindings).toHaveLength(256);
    expect(canonicalBytes(parsed.transitions.at(-1)).byteLength).toBeLessThanOrEqual(MAX_TRANSITION_ENVELOPE_BYTES);
  });

  it("permits zero findings only when exact unresolved coverage is zero", () => {
    const empty = runFixture({ key: KEY, actor: ACTOR, at: AT });
    const terminal = abandon(park(empty.content), []);
    expect(parseOperationRun(JSON.stringify(signOperationRun(KEY, terminal)), empty.binding).state).toBe("abandoned");
    const unresolved = runFixture({ key: KEY, actor: ACTOR, at: AT, authoritativeMutationCount: 1 });
    const invalid = abandon(park(unresolved.content), []);
    expect(() => parseOperationRun(JSON.stringify(signOperationRun(KEY, invalid)), unresolved.binding)).toThrow(/coverage|unresolved/i);
  });

  it("rejects re-signed top-level details that no longer match the compact binding", () => {
    const base = runFixture({ key: KEY, actor: ACTOR, at: AT, authoritativeMutationCount: 1 });
    const valid = abandon(park(base.content), base.content.obligations.authoritativeMutationIds.map(residual));
    const tampered = { ...valid, residualFindings: [{ ...valid.residualFindings[0]!, code: "tampered" }] };
    expect(() => parseOperationRun(JSON.stringify(signOperationRun(KEY, tampered)), base.binding)).toThrow(/residual.*binding|annotations/i);
  });
});
