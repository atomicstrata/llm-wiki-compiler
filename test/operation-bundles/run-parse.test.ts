/**
 * @file test/operation-bundles/run-parse.test.ts
 * @description Exact-shape and semantic refusal tests for bounded operation-run
 * records, including bindings, state edges, outcome monotonicity, and byte caps.
 */

import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MAX_RUN_BYTES, MAX_RUN_EVIDENCE_BLOB_BYTES, MAX_RUN_TRANSITIONS } from "../../src/operation-bundles/constants.js";
import { writeRunEvidenceCreateOnly } from "../../src/operation-bundles/evidence-store.js";
import { mintBundleId, mintOperationRunId, mutationId } from "../../src/operation-bundles/ids.js";
import { parseOperationRun } from "../../src/operation-bundles/run-parse.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import {
  appendOperationTransition,
  signOperationRun,
} from "../../src/operation-bundles/run-integrity.js";
import type { OperationPrincipal } from "../../src/operation-bundles/principal.js";
import type { OperationTransitionPayload, OperationTransitionType, OperationRunBinding, OperationEvidenceReference } from "../../src/operation-bundles/run-types.js";
import { runFixture } from "./run-fixture.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const KEY = Buffer.alloc(32, 7);
const AT = "2026-07-17T00:00:00.000Z";
const ACTOR: OperationPrincipal = { id: "local-operator", surface: "cli", grants: [] };
const MANIFEST_DIGEST = `sha256:${"a".repeat(64)}` as const;
const OWNER = { pid: 91, processStartTime: AT };
const EVIDENCE = { digest: MANIFEST_DIGEST, byteCount: 1, type: "observation", provenance: "test" };
const root = useTempRoot();

/** Build one signed staged run with bounded work obligations. */
function fixture(authoritativeMutationCount = 0, optionalProjectionCount = 0, requiredProjectionCount = 0) {
  const base = runFixture({ key: KEY, actor: ACTOR, at: AT, authoritativeMutationCount, optionalProjectionCount, requiredProjectionCount });
  return { ...base, signed: signOperationRun(KEY, base.content) };
}

/** Return the closed payload shape implied by one control edge. */
function defaultPayload(type: OperationTransitionType): OperationTransitionPayload {
  if (type === "approved") return { kind: "authority", authoritySnapshotDigest: MANIFEST_DIGEST };
  if (type === "apply-started" || type === "recovery-resumed" || type === "compensation-began") {
    return { kind: "execution", authoritySnapshotDigest: MANIFEST_DIGEST, applyOwner: OWNER };
  }
  return { kind: "none" };
}

/** Append one deterministic transition through the production projector. */
function transition(run: ReturnType<typeof fixture>["content"], type: OperationTransitionType, stateAfter: Parameters<typeof appendOperationTransition>[1]["stateAfter"], payload?: OperationTransitionPayload) {
  return appendOperationTransition(run, { type, stateAfter, payload: payload ?? defaultPayload(type), actor: ACTOR, at: AT });
}

/** Build one approved applying run with bounded work obligations. */
function applyingFixture(authoritativeMutationCount = 0, optionalProjectionCount = 0, requiredProjectionCount = 0) {
  const base = fixture(authoritativeMutationCount, optionalProjectionCount, requiredProjectionCount);
  const approved = transition(base.content, "approved", "approved");
  return { base, run: transition(approved, "apply-started", "applying") };
}

/** Build one applying run whose first mutation is durably started. */
function startedMutation() {
  const { base, run } = applyingFixture(1);
  const id = mutationId(base.bundleId, 0);
  const started = transition(run, "mutation-started", "applying", { kind: "mutation", mutationId: id });
  return { base, id, started };
}

describe("operation run parsing", () => {
  it("returns a fresh exact-shape run for valid bounded JSON", () => {
    const { signed, binding } = fixture();
    const parsed = parseOperationRun(JSON.stringify(signed), binding);
    expect(parsed).toEqual(signed);
    expect(parsed).not.toBe(signed);
  });

  it("rejects duplicate JSON keys and unknown fields", () => {
    const { signed, binding } = fixture();
    const duplicate = JSON.stringify(signed).replace('{"schemaVersion":1', '{"schemaVersion":1,"schemaVersion":1');
    expect(() => parseOperationRun(duplicate, binding)).toThrow(/duplicate JSON key/);
    expect(() => parseOperationRun(JSON.stringify({ ...signed, surprise: true }), binding)).toThrow(/unknown field/);
  });

  it("rejects wrong manifest, run, workspace, bundle, and key-epoch bindings", () => {
    const { signed, binding } = fixture();
    const wrong: OperationRunBinding[] = [
      { ...binding, manifestDigest: `sha256:${"b".repeat(64)}` },
      { ...binding, runId: mintOperationRunId() },
      { ...binding, workspaceId: "other" },
      { ...binding, bundleId: mintBundleId() },
      { ...binding, keyEpochId: `sha256:${"c".repeat(64)}` },
    ];
    for (const expected of wrong) {
      expect(() => parseOperationRun(JSON.stringify(signed), expected)).toThrow(/binding mismatch/);
    }
  });

  it("rejects an illegal awaiting-approval to applying edge", () => {
    const { content, binding } = fixture();
    const illegal = transition(content, "apply-started", "applying");
    expect(() => parseOperationRun(JSON.stringify(signOperationRun(KEY, illegal)), binding)).toThrow(/illegal state edge/);
  });

  it("rejects duplicate and regressed mutation outcomes", () => {
    const { base, id, started } = startedMutation();
    const outcome = { mutationId: id, status: "started" as const, transitionSequence: 3 };
    const duplicate = { ...started, mutationOutcomes: [outcome, outcome], counters: { ...started.counters, mutations: { attempted: 1, applied: 0, skipped: 0, failed: 0 } } };
    expect(() => parseOperationRun(JSON.stringify(signOperationRun(KEY, duplicate)), base.binding)).toThrow(/duplicate mutation outcome/);
    const applied = transition(started, "mutation-applied", "applying", { kind: "mutation", mutationId: id, evidence: EVIDENCE });
    const regressed = transition(applied, "mutation-started", "applying", { kind: "mutation", mutationId: id });
    expect(() => parseOperationRun(JSON.stringify(signOperationRun(KEY, regressed)), base.binding)).toThrow(/outcome regression/);
  });

  it("accepts a monotonic started-to-applied mutation outcome", () => {
    const { base, id, started } = startedMutation();
    const applied = transition(started, "mutation-applied", "applying", { kind: "mutation", mutationId: id, evidence: EVIDENCE });
    const parsed = parseOperationRun(JSON.stringify(signOperationRun(KEY, applied)), base.binding);
    expect(parsed.mutationOutcomes).toEqual([{ mutationId: id, status: "applied", transitionSequence: 4 }]);
  });

  it("authenticates an over-limit evidence reference without writing a blob", async () => {
    const { base, id, started } = startedMutation();
    const bytes = Buffer.alloc(MAX_RUN_EVIDENCE_BLOB_BYTES + 1, 0x61);
    const evidence = await writeRunEvidenceCreateOnly(root.dir, {
      workspaceId: base.binding.workspaceId, runId: base.runId,
      type: "observation", provenance: "test",
    }, bytes);
    const applied = transition(started, "mutation-applied", "applying", {
      kind: "mutation", mutationId: id, evidence,
    });

    const parsed = parseOperationRun(JSON.stringify(signOperationRun(KEY, applied)), base.binding);
    expect(parsed.transitions.at(-1)?.payload).toMatchObject({
      evidence: { ...evidence, type: "observation", provenance: "test" },
    });
    const file = operationPaths(root.dir, base.binding.workspaceId)
      .evidenceFile(base.runId, evidence.digest.slice("sha256:".length));
    await expect(access(file)).rejects.toThrow();
  });

  it("rejects an over-limit evidence reference without provenance metadata", async () => {
    const { base, id, started } = startedMutation();
    const evidence = {
      kind: "evidence-over-limit" as const, digest: EVIDENCE.digest,
      byteCount: MAX_RUN_EVIDENCE_BLOB_BYTES + 1, excerpt: "bounded",
    } as unknown as OperationEvidenceReference; // Deliberately invalid wire data exercises the parser.
    const applied = transition(started, "mutation-applied", "applying", {
      kind: "mutation", mutationId: id, evidence,
    });

    expect(() => parseOperationRun(JSON.stringify(signOperationRun(KEY, applied)), base.binding))
      .toThrow(/missing field type/);
  });

  it("rejects an applied mutation without a durable started outcome", () => {
    const { base, run } = applyingFixture(1);
    const id = mutationId(base.bundleId, 0);
    const applied = transition(run, "mutation-applied", "applying", { kind: "mutation", mutationId: id });
    expect(() => parseOperationRun(JSON.stringify(signOperationRun(KEY, applied)), base.binding)).toThrow(/started/);
  });

  it("rejects projection criticality drift after projection-started", () => {
    const { base, run } = applyingFixture(0, 0, 1);
    const id = mutationId(base.bundleId, 0);
    const started = transition(run, "projection-started", "applying", { kind: "projection", mutationId: id, criticality: "required" });
    const applied = transition(started, "projection-applied", "applying", { kind: "projection", mutationId: id, criticality: "optional", evidence: EVIDENCE });
    expect(() => parseOperationRun(JSON.stringify(signOperationRun(KEY, applied)), base.binding)).toThrow(/criticality|metadata/);
  });

  it("rejects warning success whose counts do not reconcile optional outcomes", () => {
    const { base, run } = applyingFixture(0, 1);
    const id = mutationId(base.bundleId, 0);
    const started = transition(run, "projection-started", "applying", { kind: "projection", mutationId: id, criticality: "optional" });
    const failed = transition(started, "projection-failed", "applying", { kind: "projection", mutationId: id, criticality: "optional", evidence: EVIDENCE });
    const warning = transition(failed, "warning-recorded", "applying", { kind: "warning", code: "optional-failed", attempted: 1, completed: 1, skipped: 0, failed: 0 });
    const terminal = transition(warning, "succeeded-with-warnings", "succeeded-with-warnings");
    expect(() => parseOperationRun(JSON.stringify(signOperationRun(KEY, terminal)), base.binding)).toThrow(/warning|optional/);
  });

  it("rejects a zero-count completion warning before terminal settlement", () => {
    const { base, run } = applyingFixture(0, 1);
    const warning = transition(run, "warning-recorded", "applying", {
      kind: "warning", code: "empty-warning", attempted: 0, completed: 0, skipped: 0, failed: 0,
    });
    expect(() => parseOperationRun(JSON.stringify(signOperationRun(KEY, warning)), base.binding)).toThrow(/positive attempted count/);
  });

  it("keeps a control park legal after a recorded optional warning", () => {
    const started = applyingFixture(0, 1);
    const base = started.base;
    let run = started.run;
    const id = mutationId(base.bundleId, 0);
    run = transition(run, "projection-started", "applying", { kind: "projection", mutationId: id, criticality: "optional" });
    run = transition(run, "projection-failed", "applying", { kind: "projection", mutationId: id, criticality: "optional", evidence: EVIDENCE });
    run = transition(run, "warning-recorded", "applying", { kind: "warning", code: "optional-failed", attempted: 1, completed: 0, skipped: 0, failed: 1 });
    run = transition(run, "recovery-required", "recovery-required", { kind: "problem", code: "bundle-recovery-required" });
    expect(parseOperationRun(JSON.stringify(signOperationRun(KEY, run)), base.binding).state).toBe("recovery-required");
  });

  it("rejects notices appended after a terminal transition", () => {
    const base = fixture();
    const approved = transition(base.content, "approved", "approved");
    const applying = transition(approved, "apply-started", "applying");
    const terminal = transition(applying, "succeeded", "succeeded");
    const late = transition(terminal, "notice-recorded", "succeeded", { kind: "notice", code: "late" });
    expect(() => parseOperationRun(JSON.stringify(signOperationRun(KEY, late)), base.binding)).toThrow(/terminal|state edge/);
  });

  it("rejects success while required mutation work is unresolved", () => {
    const { base, run } = applyingFixture(1);
    const succeeded = transition(run, "succeeded", "succeeded");
    expect(() => parseOperationRun(JSON.stringify(signOperationRun(KEY, succeeded)), base.binding)).toThrow(/required work is unresolved/);
  });

  it("rejects a mutation outcome appended after terminal success", () => {
    const { base, run } = applyingFixture();
    const succeeded = transition(run, "succeeded", "succeeded");
    const id = mutationId(base.bundleId, 0);
    const late = transition(succeeded, "mutation-started", "succeeded", { kind: "mutation", mutationId: id });
    expect(() => parseOperationRun(JSON.stringify(signOperationRun(KEY, late)), base.binding)).toThrow(/illegal state edge/);
  });

  it("rejects ordinary history that consumes signed control transition slots", () => {
    const base = fixture();
    const approved = transition(base.content, "approved", "approved");
    const starved = { ...approved, controlTransitionAllowance: MAX_RUN_TRANSITIONS - 1 };
    expect(() => parseOperationRun(JSON.stringify(signOperationRun(KEY, starved)), base.binding)).toThrow(/control transition headroom/);
  });

  it("rejects outcomes beyond the manifest-declared obligations", () => {
    const { base, run } = applyingFixture();
    const id = mutationId(base.bundleId, 0);
    const unexpected = transition(run, "mutation-started", "applying", { kind: "mutation", mutationId: id });
    expect(() => parseOperationRun(JSON.stringify(signOperationRun(KEY, unexpected)), base.binding)).toThrow(/foreign mutation outcome identity/);
  });

  it("rejects an ordinary transition envelope over 2 KiB", () => {
    const { signed, binding } = fixture();
    const [genesis] = signed.transitions;
    const oversized = { ...signed, transitions: [{ ...genesis, actor: { ...genesis.actor, id: "x".repeat(3_000) } }] };
    expect(() => parseOperationRun(JSON.stringify(oversized), binding)).toThrow(/transition envelope exceeds/);
  });

  it("rejects a complete record over 4 MiB before trusting fields", () => {
    const { signed, binding } = fixture();
    const oversized = JSON.stringify({ ...signed, surprise: "x".repeat(MAX_RUN_BYTES) });
    expect(() => parseOperationRun(oversized, binding)).toThrow(/byte cap/);
  });
});
