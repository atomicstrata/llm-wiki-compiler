/**
 * @file test/scale/downgrade-cancel-binding.test.ts
 * @description Witnesses that a pre-install cancel's evidence is BOUND to the
 * held plan and intent before anything is classified (Root review of
 * checkpoint 14, item 1), through the real observer (`observeCancel`) and
 * classifier on plainly written leaves. The code under test only reads, so no
 * fsync is involved: a wrong-revision but self-consistent cancel intent never
 * becomes F2, a hash a leaf supplies proves nothing about a record's content,
 * priors must be exactly the plan's, a bootstrapped intent must commit to the
 * original record, a receipt must bind to the plan's outcome, and records are
 * judged as parsed records (an exact-hash invalid "original" is not one).
 * A record past a fenced cancel's revision is observed as `later`, and a
 * moved-on record under a bootstrapped cancel as `never-fenced-later` only
 * with `.llmwiki/indexed` in place.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach } from "../config/storage-profile-hooks.js";
import { INDEXED_DIR } from "../../src/segments/contracts.js";
import { intentOf } from "../../src/scale/downgrade-apply.js";
import { observeCancel } from "../../src/scale/downgrade-cancel-observe.js";
import { classifyCancel } from "../../src/scale/downgrade-cancel-state.js";
import { SCALE_RECORD_FILE } from "../../src/scale/contracts.js";
import { serializeAnyScaleRecord } from "../../src/scale/record-v2-schema.js";
import { fenceAndCancelRecords, ORIGINAL_ESTIMATE, OTHER_SMALL_ESTIMATE, plainProject, plant, plantLeaf, sha256, type CancelProject } from "./cancel-helpers.js";

const projects: CancelProject[] = [];
afterEach(async () => { for (const project of projects.splice(0)) await project?.remove(); });

/** A plain fixture project, removed after the test. */
async function made(options: Parameters<typeof plainProject>[0] = {}): Promise<CancelProject> {
  const project = await plainProject(options);
  projects.push(project);
  return project;
}

/** The classified row of a project, or the refusal code when observation refuses. */
async function rowOf(project: CancelProject): Promise<string> {
  return observeCancel(project.root, project.plan, intentOf(project.plan)).then((seen) => classifyCancel(seen.observation), (error: { code?: string }) => `refused:${error.code}`);
}

/** Replace the scale record's bytes plainly; returns them. */
async function setRecord(project: CancelProject, record: Parameters<typeof serializeAnyScaleRecord>[0]): Promise<string> {
  const text = serializeAnyScaleRecord(record);
  await plant(project.root, SCALE_RECORD_FILE, text);
  return text;
}

/** A fenced cancel intent bound to `project`'s plan, with `overrides`. */
function fencedCancel(project: CancelProject, recordSha256: string, overrides: Record<string, unknown> = {}) {
  const identity = { kind: "file", dev: "1", ino: "2", size: "5", mtimeNs: "6" };
  const priors = project.plan.inventory.priors.map((prior) => ({ relPath: prior.relPath, sha256: prior.sha256, identity: prior.sha256 === null ? null : identity }));
  return { format: "llmwiki-scale-downgrade-cancel", version: 1, plan: project.plan.digest, phase: "fenced", fenceRevision: 3, cancelRevision: 4, recordSha256, priors, ...overrides };
}

/** A bootstrapped cancel intent bound to `project`'s plan: it commits to the original record and names no cancel revision. */
function bootstrappedCancel(project: CancelProject) {
  const intent = intentOf(project.plan);
  return { format: "llmwiki-scale-downgrade-cancel", version: 1, plan: project.plan.digest, phase: "bootstrapped", fenceRevision: 3, cancelRevision: null, recordSha256: intent.originalRecordSha256, priors: [] };
}

describe("records are judged as parsed records bound to the plan", () => {
  it("finds the original record and this plan's fence", async () => {
    const project = await made();
    expect(await rowOf(project)).toBe("B0");
    await setRecord(project, fenceAndCancelRecords(project.plan).fence);
    expect(await rowOf(project)).toBe("F0");
  });

  it("does not take a fence with another target or estimate as this plan's", async () => {
    const project = await made();
    const { fence } = fenceAndCancelRecords(project.plan);
    await setRecord(project, { ...fence, pending: { ...fence.pending!, target: "local-large" } as typeof fence.pending });
    expect(await rowOf(project)).toBe("not-pre-install");
    await setRecord(project, { ...fence, requested: OTHER_SMALL_ESTIMATE });
    expect(await rowOf(project)).toBe("not-pre-install");
  });

  it("does not take exact-hash bytes that are not a valid record as the original", async () => {
    expect(await rowOf(await made({ recordText: '{"fixture":"not a scale record"}\n' }))).toBe("not-pre-install");
  });
});

describe("a cancel intent binds to the held plan before classification", () => {
  it("accepts exactly the expected cancel record (F2)", async () => {
    const project = await made();
    const text = await setRecord(project, fenceAndCancelRecords(project.plan).cancel);
    await plantLeaf(project.root, path.posix.join(project.dir, "cancel.json"), fencedCancel(project, sha256(text)));
    expect(await rowOf(project)).toBe("F2");
  });

  it("refuses a self-consistent intent naming other revisions, even with a matching record", async () => {
    const project = await made();
    const { cancel } = fenceAndCancelRecords(project.plan);
    const text = await setRecord(project, { ...cancel, revision: 5, active: { ...cancel.active } });
    await plantLeaf(project.root, path.posix.join(project.dir, "cancel.json"), fencedCancel(project, sha256(text), { fenceRevision: 4, cancelRevision: 5 }));
    expect(await rowOf(project)).toBe("refused:scale_downgrade_partial");
  });

  it("does not let a hash the intent supplies vouch for a record with other content (F4)", async () => {
    const project = await made();
    const text = await setRecord(project, { ...fenceAndCancelRecords(project.plan).cancel, requested: ORIGINAL_ESTIMATE });
    await plantLeaf(project.root, path.posix.join(project.dir, "cancel.json"), fencedCancel(project, sha256(text)));
    expect(await rowOf(project)).toBe("F4");
  });
});

describe("a record past this plan's revisions is observed by the cancel intent's phase", () => {
  it("observes a record past a fenced cancel's revision as later (F3), not as the expected cancel record", async () => {
    const project = await made();
    const { cancel } = fenceAndCancelRecords(project.plan);
    const expectedSha = sha256(serializeAnyScaleRecord(cancel));
    await setRecord(project, { ...cancel, revision: cancel.revision + 1 });
    await plantLeaf(project.root, path.posix.join(project.dir, "cancel.json"), fencedCancel(project, expectedSha));
    expect(await rowOf(project)).toBe("F3");
  });

  it("observes a moved-on record as never-fenced-later (B2) only once the indexed stores are in place (else B3)", async () => {
    const project = await made();
    await setRecord(project, fenceAndCancelRecords(project.plan).cancel);
    await plantLeaf(project.root, path.posix.join(project.dir, "cancel.json"), bootstrappedCancel(project));
    expect(await rowOf(project)).toBe("B3");
    await mkdir(path.join(project.root, INDEXED_DIR), { recursive: true });
    expect(await rowOf(project)).toBe("B2");
  });
});

describe("a cancel intent's commitments must be exactly the plan's", () => {
  it.each<[string, (project: CancelProject) => Record<string, unknown>]>([
    ["priors in another order", (project) => ({ priors: [...fencedCancel(project, "f".repeat(64)).priors].reverse() })],
    ["a prior with another digest", (project) => ({ priors: fencedCancel(project, "f".repeat(64)).priors.map((prior, at) => (at === 0 ? { ...prior, sha256: "b".repeat(64) } : prior)) })],
    ["a present prior without an identity", (project) => ({ priors: fencedCancel(project, "f".repeat(64)).priors.map((prior) => ({ ...prior, identity: null })) })],
    ["a bootstrapped intent not committing to the original record", () => ({ phase: "bootstrapped", cancelRevision: null, recordSha256: "f".repeat(64), priors: [] })],
  ])("refuses %s", async (_label, overrides) => {
    const project = await made({ presentPrior: true });
    await setRecord(project, fenceAndCancelRecords(project.plan).fence);
    await plantLeaf(project.root, path.posix.join(project.dir, "cancel.json"), fencedCancel(project, "f".repeat(64), overrides(project)));
    expect(await rowOf(project)).toBe("refused:scale_downgrade_partial");
  });
});

describe("a receipt binds to the cancel intent and the held plan's outcome", () => {
  /** A bootstrapped cancel intent over the original record, and a receipt with `overrides`; returns the project. */
  async function withReceipt(overrides: Record<string, unknown>): Promise<CancelProject> {
    const project = await made();
    const intent = intentOf(project.plan);
    const cancelSha = await plantLeaf(project.root, path.posix.join(project.dir, "cancel.json"), bootstrappedCancel(project));
    await plantLeaf(project.root, path.posix.join(project.dir, "cancel-receipt.json"), { format: "llmwiki-scale-downgrade-cancel-receipt", version: 1, plan: project.plan.digest,
      phase: "bootstrapped", fenceRevision: 3, cancelRevision: null, recordSha256: intent.originalRecordSha256, cancelIntentSha256: cancelSha, estimate: "unchanged", laterRecord: null, ...overrides });
    return project;
  }

  it("accepts a bound receipt (B4)", async () => {
    expect(await rowOf(await withReceipt({}))).toBe("B4");
  });

  it.each<[string, Record<string, unknown>]>([
    ["the other phase's estimate outcome", { estimate: "planned-kept" }],
    ["other cancel-intent bytes", { cancelIntentSha256: "d".repeat(64) }],
  ])("does not count a receipt with %s", async (_label, overrides) => {
    expect(await rowOf(await withReceipt(overrides))).toBe("evidence-invalid");
  });
});
