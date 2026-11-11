/**
 * @file test/storage/page-evidence-forms-binding.test.ts
 * @description Two page-evidence capture forms as the ONE bodies they already
 * are over `PageEvidenceReads`, with no project: `captureArtifactDerefFrom`
 * and `captureRunBindingFrom`. The bodies existed before this file; it adds the
 * memory witnesses they lacked.
 *
 * HOW IT IS BUILT. Memory reads answer only the members each form may ask for,
 * log every call, and fail the test on any other read. Each form is pinned on its
 * happy seal and its essential refusals, with the reads each reached: the
 * artifact deref's declared-field, ref, type and rewrite refusals before or after
 * the resolve and body reads; the run binding's foreign-action, foreign-slug and
 * unfinished-run refusals in their locate, input, resolve order.
 *
 * NOT SHOWN HERE: every output-congruence refusal and the disk readers; the
 * page-evidence capture and synthetic suites show those.
 */

import { describe, expect, it } from "bun:test";
import { hashArtifactBody } from "../../src/artifacts/store.js";
import { captureArtifactDerefFrom, captureRunBindingFrom, type PageEvidenceReads } from "../../src/products/page-evidence-forms.js";

/** Memory reads answering `members`, logging each call; any other member fails the test. */
function readsOf(log: string[], members: Record<string, (...args: never[]) => unknown>): PageEvidenceReads {
  return new Proxy({}, {
    get: (_target, name) => {
      const member = members[String(name)];
      if (member === undefined) return () => { throw new Error(`unasked read ${String(name)}`); };
      return async (...args: never[]) => { log.push(String(name)); return member(...args); };
    },
  }) as never;
}

const BODY = "the artifact body";
const REF = `report/r1@sha256:${hashArtifactBody(BODY)}`;
const LOADED = { profile: { artifacts: { report: { fileName: "report.md", contentKind: "text", maxBytes: 1000 } } } } as never;
const DEREF = { form: "artifact-deref", captureId: "rep", refField: "report", artifactType: "report", maxBytes: 64 } as never;
const DECLARED = { report: { type: "string" } };

/** Run the artifact deref over memory reads resolving `health` and reading `body`. */
async function deref(meta: Record<string, unknown>, opts: { health?: string; body?: string; declared?: object } = {}) {
  const log: string[] = [];
  const reads = readsOf(log, {
    resolve: () => ({ health: opts.health ?? "ok" }),
    readBody: (...args: never[]) => { log.push(`body ${(args as unknown[]).join(" ")}`); return { kind: "ok", body: opts.body ?? BODY }; },
  });
  return [await captureArtifactDerefFrom(reads, LOADED, meta, DEREF, "page p1", "declared" in opts ? opts.declared as never : DECLARED), log];
}

describe("the artifact deref form over memory reads", () => {
  it("A1 seals the pinned ref, its digest and byte count after resolving and reading the declared body under the capture's cap", async () => {
    expect(await deref({ report: REF })).toEqual([{ seal: {
      "rep-ref": REF, "rep-sha256": hashArtifactBody(BODY), "rep-byte-count": String(Buffer.byteLength(BODY)),
    } }, ["resolve", "readBody", "body report r1 report.md 64"]]);
  });

  it("A2 refuses an undeclared field, a missing ref and a foreign type before any read", async () => {
    const refusals = [await deref({ report: REF }, { declared: undefined }), await deref({ report: "not-a-ref" }), await deref({ report: `memo/r1@sha256:${"a".repeat(64)}` })];
    expect(refusals.map(([outcome, log]) => [Object.keys(outcome as object), log])).toEqual([[["refused"], []], [["refused"], []], [["refused"], []]]);
  });

  it("A3 refuses an unhealthy artifact before its body, and a body rewritten since the pin after it", async () => {
    expect(await deref({ report: REF }, { health: "missing" })).toEqual([{ refused: "capture rep: the pinned artifact is missing" }, ["resolve"]]);
    expect((await deref({ report: REF }, { body: "rewritten" }))[0]).toEqual({ refused: "capture rep: the artifact was rewritten during capture; retry" });
  });
});

const DIGEST = `sha256:${"b".repeat(64)}`;
const BINDING = {
  form: "run-binding", captureId: "run", runIdFrom: "runId",
  expect: { actionId: "act", state: "succeeded", slugField: "slug" },
  frozenFields: [{ captureId: "topic", field: "topic", maxBytes: 32 }],
  outputs: [{ captureId: "draft", logicalPhaseId: "write", refKind: "output", refProvenanceLabel: "draft", maxBytes: 100 }],
} as never;
const RUN = {
  state: "succeeded",
  phaseSummaries: [{ logicalPhaseId: "write", state: "succeeded", currentAttemptId: "att-2", outputEvidenceDigest: DIGEST }],
  evidenceRefs: [{ kind: "output", provenanceLabel: "draft", digest: DIGEST, byteCount: 42, producer: { kind: "provider", attemptId: "att-2" } }],
};

/** Run the run binding over memory reads for a run of `actionId` sealed for `slug` in `state`. */
async function bind(world: { actionId?: string; slug?: string; state?: string } = {}) {
  const log: string[] = [];
  const reads = readsOf(log, {
    locateManifest: () => ({ ok: true, manifest: { plan: { actionAuthority: { actionId: world.actionId ?? "act" } } } }),
    initialInput: () => ({ ok: true, record: { slug: world.slug ?? "p1", topic: "nets" } }),
    resolveRun: () => ({ ok: true, run: { ...RUN, state: world.state ?? "succeeded" } }),
  });
  return [await captureRunBindingFrom(reads, BINDING, "prr_1", "p1"), log];
}

describe("the run binding form over memory reads", () => {
  it("R1 seals the run, its frozen field and the current attempt's output after locate, input and resolve", async () => {
    expect(await bind()).toEqual([{ seal: {
      "run-run": "prr_1", "topic-value": "nets", "topic-sha256": expect.any(String), "topic-byte-count": "4",
      "draft-sha256": "b".repeat(64), "draft-byte-count": "42",
    } }, ["locateManifest", "initialInput", "resolveRun"]]);
  });

  it("R2 refuses a foreign action after locate, a foreign slug after the input, and an unfinished run after resolve", async () => {
    const outcomes = [await bind({ actionId: "other" }), await bind({ slug: "p2" }), await bind({ state: "running" })];
    expect(outcomes.map(([, log]) => log)).toEqual([["locateManifest"], ["locateManifest", "initialInput"], ["locateManifest", "initialInput", "resolveRun"]]);
    expect(outcomes.map(([outcome]) => (outcome as { refused: string }).refused)).toEqual([
      "capture run: run prr_1 is not a act run", "capture run: run prr_1 was sealed for \"p2\", not \"p1\"",
      "capture run: run prr_1 is running; succeeded is required",
    ]);
  });
});
