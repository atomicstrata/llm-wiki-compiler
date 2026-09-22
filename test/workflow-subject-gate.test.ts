/**
 * @file test/workflow-subject-gate.test.ts
 * @description Proves that a subject-bound human gate requires a healthy,
 * pinned verifier receipt; records the exact displayed subject digest; and
 * refuses artifact, process, predecessor, or live-target drift.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useTempRoot } from "./fixtures/temp-root.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { approveGate, resolveGateChallenge } from "../src/workflows/gate.js";
import { readRun, writeRun } from "../src/workflows/store.js";
import { artifactPaths } from "../src/artifacts/store.js";
import { createVerifierRegistry, type HostVerifierImplementationV1 } from "../src/workflows/verifier-registry.js";
import { mintVerifierReceipt } from "../src/workflows/verifier-receipt.js";
import {
  recordSubjectSnapshot, SUBJECT_IMPLEMENTATION_DIGEST, SUBJECT_VERIFIER_ID,
} from "./fixtures/subject-gate-product.js";

const root = useTempRoot();
afterEach(() => { delete process.env.LLMWIKI_TRUSTED_WRITE; });
/** A verifier whose accepted subject includes the current article bytes. */
function verifier(): HostVerifierImplementationV1 {
  return {
    verifierId: SUBJECT_VERIFIER_ID, implementationDigest: SUBJECT_IMPLEMENTATION_DIGEST,
    async verify() {
      return {
        kind: "accepted", normalizedEnvelope: { coverage: "complete" }, boundValues: {},
        liveTargetPageIds: ["docs/story"],
      };
    },
  };
}

/** Activate, write an article, record evidence, mint its receipt, and enter review. */
async function reviewRun() {
  await mkdir(path.join(root.dir, "wiki/docs"), { recursive: true });
  await writeFile(path.join(root.dir, "wiki/docs/story.md"), "---\ntitle: Story\n---\n\nOriginal.\n");
  const submitted = await recordSubjectSnapshot(root.dir);
  const ref = submitted.run.outputs.check as { artifactType: string; slug: string; sha256: string };
  await mintVerifierReceipt(
    root.dir, submitted.run.runId, "check", `${ref.artifactType}/${ref.slug}@sha256:${ref.sha256}`,
    SUBJECT_VERIFIER_ID, createVerifierRegistry([verifier()]),
  );
  return (await advanceWorkflow(root.dir, submitted.run.runId)).run;
}

describe("subject-bound gate approval", () => {
  it("records the exact pre-confirmation subject digest", async () => {
    const run = await reviewRun();
    const challenge = await resolveGateChallenge(root.dir, run.runId, "editor");
    expect(challenge).toMatchObject({ kind: "human" });
    expect(challenge.subjectDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const approved = await approveGate(root.dir, run.runId, "editor", {
      actorKind: "human", actorLabel: "operator", expectedSubjectDigest: challenge.subjectDigest,
    });
    expect(approved.events.at(-1)).toMatchObject({
      type: "gate-approved", actorKind: "human", subjectDigest: challenge.subjectDigest,
    });
  });

  it("refuses a subject gate when no core-minted receipt exists", async () => {
    const submitted = await recordSubjectSnapshot(
      root.dir, '{"coverage":"complete","verdict":"accepted"}', "forged",
    );
    await advanceWorkflow(root.dir, submitted.run.runId);
    await expect(resolveGateChallenge(root.dir, submitted.run.runId, "editor"))
      .rejects.toMatchObject({ reason: "receipt-missing" });
  });

  it("refuses approval after the bound live article changes", async () => {
    const run = await reviewRun();
    const challenge = await resolveGateChallenge(root.dir, run.runId, "editor");
    await writeFile(path.join(root.dir, "wiki/docs/story.md"), "---\ntitle: Story\n---\n\nChanged.\n");
    await expect(approveGate(root.dir, run.runId, "editor", {
      actorKind: "human", expectedSubjectDigest: challenge.subjectDigest,
    })).rejects.toMatchObject({ reason: "live-target-drift" });
  });

  it("refuses when the confirmed digest is not the current subject", async () => {
    const run = await reviewRun();
    const before = await readRun(root.dir, run.runId);
    await expect(approveGate(root.dir, run.runId, "editor", {
      actorKind: "human", expectedSubjectDigest: `sha256:${"0".repeat(64)}`,
    })).rejects.toMatchObject({ reason: "confirmation-subject-mismatch" });
    expect(await readRun(root.dir, run.runId)).toEqual(before);
  });

  it("refuses after the retained approval artifact is tampered", async () => {
    const run = await reviewRun();
    const receipt = run.verifierReceipts!.check;
    const ref = run.outputs.check as { artifactType: string; slug: string };
    const file = artifactPaths(root.dir, ref.artifactType, ref.slug, "snapshot.json").bytesPath;
    await writeFile(file, '{"coverage":"tampered"}');
    await expect(resolveGateChallenge(root.dir, run.runId, "editor"))
      .rejects.toMatchObject({ reason: "artifact-drift" });
    expect(receipt.rawArtifactRef).toContain("snapshot/review-one@sha256:");
  });

  it("refuses a receipt whose pinned verifier implementation was rewritten", async () => {
    const run = await reviewRun();
    const receipt = run.verifierReceipts!.check;
    await writeRun(root.dir, { ...run, verifierReceipts: { check: {
      ...receipt, verifierImplementationDigest: `sha256:${"0".repeat(64)}`,
    } } });
    await expect(resolveGateChallenge(root.dir, run.runId, "editor"))
      .rejects.toMatchObject({ reason: "verifier-implementation-drift" });
  });
});
