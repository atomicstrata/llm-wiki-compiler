/**
 * @file test/workflow-digest.test.ts
 * @description Tests for the per-workflow content digest (Phase 5).
 *
 * `workflowDefDigest` is the durable identity of a SINGLE workflow sub-object,
 * computed over its RFC 8785 (JCS) canonicalization. These tests pin: the digest
 * is a deterministic lowercase-hex SHA-256; it is stable across cosmetic key
 * reordering of the def; and it CHANGES when a stage is added or edited. Digesting
 * a workflow in isolation (not the whole profile) means editing an unrelated
 * profile section leaves a workflow's digest stable.
 */

import { describe, it, expect } from "vitest";
import { workflowDefDigest } from "../src/profile/workflow-digest.js";
import type { WorkflowDef } from "../src/profile/types.js";

/** A two-stage workflow def used as the digest fixture. */
function sampleDef(): WorkflowDef {
  return {
    stages: [
      { id: "draft", reads: ["ideas"], writes: ["ideas"] },
      { id: "run", reads: ["ideas"], writes: ["experiments"], gate: "human:reviewer" },
    ],
  };
}

describe("workflowDefDigest", () => {
  it("is a deterministic lowercase-hex sha256 for the same def", () => {
    const digest = workflowDefDigest(sampleDef());
    expect(digest).toBe(workflowDefDigest(sampleDef()));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across cosmetic key reordering of the def", () => {
    const canonical: WorkflowDef = {
      projectionFile: "wiki/flow.md",
      stages: [{ id: "draft", reads: ["ideas"], writes: ["experiments"], gate: "human:reviewer" }],
    };
    const reordered = {
      stages: [{ writes: ["experiments"], reads: ["ideas"], id: "draft", gate: "human:reviewer" }],
      projectionFile: "wiki/flow.md",
    } as WorkflowDef;
    expect(workflowDefDigest(reordered)).toBe(workflowDefDigest(canonical));
  });

  it("changes when a stage is added", () => {
    const base = sampleDef();
    const extended: WorkflowDef = {
      stages: [...base.stages, { id: "publish", reads: ["experiments"], writes: ["experiments"] }],
    };
    expect(workflowDefDigest(extended)).not.toBe(workflowDefDigest(base));
  });

  it("changes when a stage is edited", () => {
    const base = sampleDef();
    const edited: WorkflowDef = {
      stages: [{ ...base.stages[0], writes: ["experiments"] }, base.stages[1]],
    };
    expect(workflowDefDigest(edited)).not.toBe(workflowDefDigest(base));
  });
});
