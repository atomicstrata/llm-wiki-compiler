/**
 * @file test/artifacts/execution-provenance-conjuncts.test.ts
 * @description Every CONJUNCT of the execution-provenance verifier, witnessed
 * against a synthetic store so each has a mutant that dies: a run that admitted
 * the exact bytes but settled `failed` does NOT vouch (mutant: drop the exact-
 * `succeeded` check); a run under a DIFFERENT action id does not (mutant: drop
 * the action filter); a degraded inventory PARKS, never denies (mutant: treat
 * problems as clean); an unreadable candidate PARKS (mutant: count it as
 * no-match); a non-provider producer or an initial-input ref does not vouch
 * (mutant: drop the producer/kind conjuncts).
 *
 * This file runs the verifier's ONE BODY, `verifyExecutionProvenanceFrom`,
 * over a synthetic double of its three reads. The second block shows which
 * reads are made and that a read's rejection is not caught.
 *
 * NOT SHOWN HERE: anything about the disk. NO TEST runs this verifier over a
 * real preparation store with a candidate run: no test profile on disk declares
 * an execution-provenance requirement. `execution-provenance-scan-binding.test.ts`
 * runs the real SCAN binding on an empty root and nothing more; the
 * sealed-input and run bindings are executed by no test.
 */

import { describe, expect, it } from "bun:test";
import {
  verifyExecutionProvenanceFrom, type ExecutionProvenanceReads,
} from "../../src/artifacts/execution-provenance.js";
import type { PreparationManifestV1 } from "../../src/preparations/manifest-parse.js";
import type { PreparationRunV1 } from "../../src/preparations/run-types.js";
import type { ExecutionProvenanceReq } from "../../src/profile/types.js";

const REQ: ExecutionProvenanceReq = { actionId: "demo.execute", slugInputField: "slug", resultOutputId: "result" };
const DIGEST = `sha256:${"a".repeat(64)}`;

/** A candidate: its manifest's action id + run id, the frozen input, and the run's state + evidence. */
interface Candidate {
  actionId?: string;
  input?: Record<string, unknown> | "unreadable";
  state?: PreparationRunV1["state"];
  evidence?: Array<{ kind: string; provenanceLabel?: string; producer: { kind: string }; digest: string }>;
}

/** Build a synthetic store over `candidates`; `problems` marks the scan degraded. */
function storeOf(candidates: readonly Candidate[], problems: readonly unknown[] = []): ExecutionProvenanceReads {
  const manifests = candidates.map((candidate, index) => ({
    runId: `prr_${index}`, plan: { actionAuthority: { actionId: candidate.actionId ?? REQ.actionId } },
  })) as unknown as PreparationManifestV1[];
  return {
    scanInventory: async () => ({ manifests, problems }),
    readInitialInput: async (manifest) => {
      const candidate = candidates[Number(manifest.runId.slice(4))]!;
      const input = candidate.input ?? { slug: "probe" };
      return input === "unreadable" ? { ok: false, reason: "sealed input is unavailable" } : { ok: true, record: input };
    },
    resolveRun: async (runId) => {
      const candidate = candidates[Number(runId.slice(4))]!;
      const run = {
        state: candidate.state ?? "succeeded",
        evidenceRefs: candidate.evidence ?? [{ kind: "provider-output", provenanceLabel: "result", producer: { kind: "provider" }, digest: DIGEST }],
      } as unknown as PreparationRunV1;
      return { ok: true, binding: {} as never, run };
    },
  };
}

const verdictOf = (store: ExecutionProvenanceReads) => verifyExecutionProvenanceFrom(store, REQ, "probe", DIGEST);

describe("execution-provenance conjuncts", () => {
  it("PASSES only the fully matching succeeded run (the positive control)", async () => {
    expect((await verdictOf(storeOf([{}]))).verdict).toBe("pass");
  });

  it("DENIES a run that admitted the exact bytes but did not settle `succeeded`", async () => {
    for (const state of ["failed", "cancelled", "running", "succeeded-with-warnings"] as const) {
      expect((await verdictOf(storeOf([{ state }]))).verdict, state).toBe("deny");
    }
  });

  it("DENIES a run under a DIFFERENT action id, even with the exact digest admitted", async () => {
    expect((await verdictOf(storeOf([{ actionId: "other.action" }]))).verdict).toBe("deny");
  });

  it("DENIES an initial-input ref, a foreign output id, and a non-provider producer carrying the digest", async () => {
    const cases = [
      [{ kind: "initial-input", producer: { kind: "provider" }, digest: DIGEST }],
      [{ kind: "provider-output", provenanceLabel: "rows", producer: { kind: "provider" }, digest: DIGEST }],
      [{ kind: "provider-output", provenanceLabel: "result", producer: { kind: "host" }, digest: DIGEST }],
    ];
    for (const evidence of cases) expect((await verdictOf(storeOf([{ evidence }]))).verdict, JSON.stringify(evidence)).toBe("deny");
  });

  it("PARKS (never denies) on a degraded inventory — the vouching run may have been dropped", async () => {
    const verdict = await verdictOf(storeOf([{ state: "failed" }], ["truncated"]));
    expect(verdict.verdict).toBe("park");
    expect(verdict.detail).toMatch(/problem/);
  });

  it("PARKS when a same-action candidate's sealed input could not be read", async () => {
    expect((await verdictOf(storeOf([{ input: "unreadable" }]))).verdict).toBe("park");
  });

  it("PARKS when a candidate run itself is unavailable, but DENIES a run the store settles as absent", async () => {
    const unavailable: ExecutionProvenanceReads = { ...storeOf([{}]), resolveRun: async () => ({ ok: false, failure: "unavailable", reason: "torn" }) };
    const absent: ExecutionProvenanceReads = { ...storeOf([{}]), resolveRun: async () => ({ ok: false, failure: "denied", reason: "no such run" }) };
    expect((await verdictOf(unavailable)).verdict).toBe("park");
    expect((await verdictOf(absent)).verdict).toBe("deny");
  });

  it("PARKS when the scan itself throws, and DENIES a clean scan with no candidate at all", async () => {
    const throwing: ExecutionProvenanceReads = { ...storeOf([]), scanInventory: async () => { throw new Error("EIO"); } };
    expect((await verdictOf(throwing)).verdict).toBe("park");
    expect((await verdictOf(storeOf([]))).verdict).toBe("deny");
  });
});

/** `reads` with every call logged BEFORE it is made, into one ordered log. */
function logged(reads: ExecutionProvenanceReads, calls: string[]): ExecutionProvenanceReads {
  return {
    scanInventory: () => { calls.push("scan"); return reads.scanInventory(); },
    readInitialInput: (manifest) => { calls.push(`input ${manifest.runId}`); return reads.readInitialInput(manifest); },
    resolveRun: (runId) => { calls.push(`run ${runId}`); return reads.resolveRun(runId); },
  };
}

describe("execution-provenance reads: which are made, and what a rejection does", () => {
  it("P9 reads no input for another action and no run for another slug", async () => {
    const calls: string[] = [];
    const verdict = await verdictOf(logged(storeOf([{ actionId: "other.action" }, { input: { slug: "other" } }, {}]), calls));
    expect(calls).toEqual(["scan", "input prr_1", "input prr_2", "run prr_2"]);
    expect(verdict).toEqual({ verdict: "pass", detail: "run prr_2 admitted the pinned bytes under output 'result'" });
  });

  it("P10 reads nothing after the first candidate that vouches", async () => {
    const calls: string[] = [];
    expect((await verdictOf(logged(storeOf([{}, {}]), calls))).verdict).toBe("pass");
    expect(calls).toEqual(["scan", "input prr_0", "run prr_0"]);
  });

  it("P11 rejects with the same error when the sealed-input read or the run read rejects: only the scan is caught", async () => {
    const refused = new Error("EIO: read refused");
    const input: ExecutionProvenanceReads = { ...storeOf([{}]), readInitialInput: async () => { throw refused; } };
    const run: ExecutionProvenanceReads = { ...storeOf([{}]), resolveRun: async () => { throw refused; } };
    await expect(verdictOf(input)).rejects.toBe(refused);
    await expect(verdictOf(run)).rejects.toBe(refused);
  });
});
