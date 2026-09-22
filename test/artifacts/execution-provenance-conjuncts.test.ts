/**
 * @file test/artifacts/execution-provenance-conjuncts.test.ts
 * @description Every CONJUNCT of the execution-provenance verifier, witnessed
 * against a synthetic store so each has a mutant that dies: a run that admitted
 * the exact bytes but settled `failed` does NOT vouch (mutant: drop the exact-
 * `succeeded` check); a run under a DIFFERENT action id does not (mutant: drop
 * the action filter); a degraded inventory PARKS, never denies (mutant: treat
 * problems as clean); an unreadable candidate PARKS (mutant: count it as
 * no-match); a non-provider producer or an initial-input ref does not vouch
 * (mutant: drop the producer/kind conjuncts). The packaged journey witnesses
 * the same verifier over the real store; this file isolates the guard.
 */

import { describe, expect, it } from "vitest";
import {
  verifyExecutionProvenanceWith, type ExecutionProvenanceStoreV1,
} from "../../src/artifacts/execution-provenance.js";
import type { PreparationManifestV1 } from "../../src/preparations/manifest-parse.js";
import type { PreparationRunV1 } from "../../src/preparations/run-types.js";
import type { ExecutionProvenanceReq } from "../../src/profile/types.js";

const REQ: ExecutionProvenanceReq = { actionId: "demo.execute", slugInputField: "slug", resultOutputId: "result" };
const DIGEST = `sha256:${"a".repeat(64)}`;
const ROOT = "/synthetic";

/** A candidate: its manifest's action id + run id, the frozen input, and the run's state + evidence. */
interface Candidate {
  actionId?: string;
  input?: Record<string, unknown> | "unreadable";
  state?: PreparationRunV1["state"];
  evidence?: Array<{ kind: string; provenanceLabel?: string; producer: { kind: string }; digest: string }>;
}

/** Build a synthetic store over `candidates`; `problems` marks the scan degraded. */
function storeOf(candidates: readonly Candidate[], problems: readonly unknown[] = []): ExecutionProvenanceStoreV1 {
  const manifests = candidates.map((candidate, index) => ({
    runId: `prr_${index}`, plan: { actionAuthority: { actionId: candidate.actionId ?? REQ.actionId } },
  })) as unknown as PreparationManifestV1[];
  return {
    scanInventory: async () => ({ manifests, problems }),
    readInitialInput: async (_root, manifest) => {
      const candidate = candidates[Number(manifest.runId.slice(4))]!;
      const input = candidate.input ?? { slug: "probe" };
      return input === "unreadable" ? { ok: false, reason: "sealed input is unavailable" } : { ok: true, record: input };
    },
    resolveRun: async (_root, runId) => {
      const candidate = candidates[Number(runId.slice(4))]!;
      const run = {
        state: candidate.state ?? "succeeded",
        evidenceRefs: candidate.evidence ?? [{ kind: "provider-output", provenanceLabel: "result", producer: { kind: "provider" }, digest: DIGEST }],
      } as unknown as PreparationRunV1;
      return { ok: true, binding: {} as never, run };
    },
  };
}

const verdictOf = (store: ExecutionProvenanceStoreV1) => verifyExecutionProvenanceWith(store, ROOT, REQ, "probe", DIGEST);

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
    const unavailable: ExecutionProvenanceStoreV1 = { ...storeOf([{}]), resolveRun: async () => ({ ok: false, failure: "unavailable", reason: "torn" }) };
    const absent: ExecutionProvenanceStoreV1 = { ...storeOf([{}]), resolveRun: async () => ({ ok: false, failure: "denied", reason: "no such run" }) };
    expect((await verdictOf(unavailable)).verdict).toBe("park");
    expect((await verdictOf(absent)).verdict).toBe("deny");
  });

  it("PARKS when the scan itself throws, and DENIES a clean scan with no candidate at all", async () => {
    const throwing: ExecutionProvenanceStoreV1 = { ...storeOf([]), scanInventory: async () => { throw new Error("EIO"); } };
    expect((await verdictOf(throwing)).verdict).toBe("park");
    expect((await verdictOf(storeOf([]))).verdict).toBe("deny");
  });
});
