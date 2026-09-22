/**
 * @file test/workflow-verifier-receipt.test.ts
 * @description Proves that verifier receipts are host-minted from a pinned
 * implementation, bind product/run/workspace authority, and cannot be supplied
 * by an ordinary artifact output even when its JSON looks fully accepted.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalWorkflowHost } from "../src/local-workflow-host/index.js";
import { createLocalWorkflowRuntime } from "../src/workflows/runtime.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import {
  createVerifierRegistry,
  type HostVerifierImplementationV1,
} from "../src/workflows/verifier-registry.js";
import { mintVerifierReceipt } from "../src/workflows/verifier-receipt.js";
import { readRun } from "../src/workflows/store.js";
import {
  recordSubjectSnapshot, SUBJECT_IMPLEMENTATION_DIGEST, SUBJECT_VERIFIER_ID,
} from "./fixtures/subject-gate-product.js";

const root = useTempRoot();
afterEach(() => { delete process.env.LLMWIKI_TRUSTED_WRITE; });
/** Activate the product and record one snapshot artifact on its first stage. */
async function snapshotRun(body = '{"coverage":"complete"}') {
  return (await recordSubjectSnapshot(root.dir, body)).run;
}

/** A pinned test verifier that derives its verdict from the verified artifact bytes. */
function verifier(): HostVerifierImplementationV1 {
  return {
    verifierId: SUBJECT_VERIFIER_ID, implementationDigest: SUBJECT_IMPLEMENTATION_DIGEST,
    async verify(input) {
      const report = JSON.parse(input.rawArtifactBytes.toString("utf8")) as { coverage?: string };
      if (report.coverage !== "complete") return { kind: "rejected", reasonCode: "coverage-incomplete" };
      return { kind: "accepted", normalizedEnvelope: { coverage: "complete" }, boundValues: {} };
    },
  };
}

describe("core-minted verifier receipts", () => {
  it("uses supplied host evidence observations and persistence when constructed", async () => {
    const run = await snapshotRun();
    const ref = run.outputs.check as { artifactType: string; slug: string; sha256: string };
    const base = createLocalWorkflowHost();
    const artifactBody = vi.fn(base.observations.artifactBody);
    const processSource = vi.fn(base.observations.processSource);
    const write = vi.fn(base.records.write);
    const runtime = createLocalWorkflowRuntime({ ...base, records: { ...base.records, write },
      observations: { ...base.observations, artifactBody, processSource } });
    const receipt = await runtime.mintVerifierReceipt(root.dir, run.runId, "check",
      `${ref.artifactType}/${ref.slug}@sha256:${ref.sha256}`, SUBJECT_VERIFIER_ID, createVerifierRegistry([verifier()]));
    expect(artifactBody).toHaveBeenCalledOnce();
    expect(processSource).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(await base.history.read(root.dir, run.runId))
      .toMatchObject({ status: "ok", run: { verifierReceipts: { check: receipt } } });
  });

  it("runs the process-pinned implementation and binds the current authority", async () => {
    const run = await snapshotRun();
    const ref = run.outputs.check as { artifactType: string; slug: string; sha256: string };
    const receipt = await mintVerifierReceipt(
      root.dir, run.runId, "check", `${ref.artifactType}/${ref.slug}@sha256:${ref.sha256}`,
      SUBJECT_VERIFIER_ID, createVerifierRegistry([verifier()]),
    );
    expect(receipt).toMatchObject({
      schemaVersion: 1, verifierId: SUBJECT_VERIFIER_ID,
      verifierImplementationDigest: SUBJECT_IMPLEMENTATION_DIGEST,
      runId: run.runId, workspaceId: "desk-one",
      processDefinitionDigest: run.processAuthority?.processDefinitionDigest,
    });
    const persisted = await readRun(root.dir, run.runId);
    expect(persisted.status).toBe("ok");
    if (persisted.status === "ok") expect(persisted.run.verifierReceipts?.check).toEqual(receipt);
  });

  it("rejects evidence the verifier does not accept and records no receipt", async () => {
    const run = await snapshotRun('{"coverage":"incomplete"}');
    const ref = run.outputs.check as { artifactType: string; slug: string; sha256: string };
    await expect(mintVerifierReceipt(
      root.dir, run.runId, "check", `${ref.artifactType}/${ref.slug}@sha256:${ref.sha256}`,
      SUBJECT_VERIFIER_ID, createVerifierRegistry([verifier()]),
    )).rejects.toMatchObject({ reason: "coverage-incomplete" });
    const persisted = await readRun(root.dir, run.runId);
    if (persisted.status === "ok") expect(persisted.run.verifierReceipts).toBeUndefined();
  });

  it("does not trust a caller-shaped all-accepted envelope in ordinary artifact bytes", async () => {
    const forged = JSON.stringify({
      coverage: "complete", verdict: "accepted",
      verifierReceipt: {
        verifierId: SUBJECT_VERIFIER_ID, implementationDigest: SUBJECT_IMPLEMENTATION_DIGEST,
      },
    });
    const run = await snapshotRun(forged);
    expect(run.verifierReceipts).toBeUndefined();
  });
});
