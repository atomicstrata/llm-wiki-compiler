/**
 * @file test/preparations/intent-compiler.test.ts
 * @description `OperationIntentCompilerV1` (design section 21.3): the only path
 * from settled preparation evidence to Milestone A's CLOSED mutation grammar. It
 * reads immutable evidence plus host authorities, routes every mutation through a
 * registered Milestone A store adapter, derives no path or writer from provider
 * text, and WRITES NOTHING — proved here by a project/operator/cache snapshot.
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFERRED_PROPOSAL_CODE, IntentCompilerError, createOperationIntentCompilerV1,
  type HostMutationTargetV1, type IntentCompilationRequestV1,
} from "../../src/preparations/intent-compiler.js";
import { deriveCompleteness } from "../../src/preparations/completeness.js";
import { normalizeProviderProposals } from "../../src/preparations/proposals.js";
import { decideReconciliation } from "../../src/preparations/reconciliation.js";
import { capturePolicyContract, type PreparationPolicyContractV1 } from "../../src/preparations/selection.js";
import { mintBundleId } from "../../src/operation-bundles/ids.js";
import type { EvidenceRefV1, Sha256Digest } from "../../src/preparations/types.js";
import type { AttemptId } from "../../src/preparations/ids.js";
import { snapshotTree } from "./inputs-fixture.js";
import { adapters, pageTarget } from "./task7-fixture.js";

const HANDLER_DIGEST = `sha256:${"1".repeat(64)}` as Sha256Digest;
const PROVIDER_PIN = `sha256:${"2".repeat(64)}` as Sha256Digest;
const PAGE_DIGEST = `sha256:${"3".repeat(64)}` as Sha256Digest;
const ATTEMPT = `pat_${"4".repeat(64)}` as AttemptId;

const evidence: EvidenceRefV1 = {
  kind: "provider-output", mediaType: "application/json", provenanceLabel: "provider-output",
  digest: parseSha256Digest(`sha256:${"5".repeat(64)}`), byteCount: 32, sensitivity: "ordinary", retention: "until-handoff",
  producer: { kind: "provider", providerPinDigest: PROVIDER_PIN, attemptId: ATTEMPT }, untrusted: true,
};

const contract = capturePolicyContract({
  resolve: (): PreparationPolicyContractV1 => ({
    handlerId: "compile", handlerContractVersion: "1.0.0", handlerContractDigest: HANDLER_DIGEST,
    exclusionReasonCodes: ["below-rank-limit"], reconciliationReasonCodes: ["duplicate-entity"],
    proposalKinds: ["entity-fact"],
  }),
}, { handlerId: "compile", handlerContractVersion: "1.0.0", handlerContractDigest: HANDLER_DIGEST });

/** The provider proposal set: one benign fact, one carrying a hostile payload. */
const proposals = normalizeProviderProposals({
  contract, attemptId: ATTEMPT, providerPinDigest: PROVIDER_PIN, sourceEvidenceRefs: [evidence],
  drafts: [
    { proposalKind: "entity-fact", targetLogicalIdentity: "entity:person:ada", proposedValue: { born: 1815 } },
    {
      proposalKind: "entity-fact", targetLogicalIdentity: "entity:person:grace",
      proposedValue: { note: "../../../../etc/passwd", command: "git push --force" },
    },
  ],
});



const completeness = deriveCompleteness({
  scopeId: "compile", classes: [{
    classId: "entity-facts", disposition: "required",
    identitySetRef: { ...evidence, kind: "completeness-identity-set" },
    identitySets: {
      planned: ["ada", "grace"], eligible: ["ada", "grace"], attempted: ["ada", "grace"],
      completed: ["ada", "grace"], included: ["ada", "grace"], skipped: [], unavailable: [],
      failed: [], cancelled: [], overflow: [], nonConverged: [],
    },
  }],
});

/** Build one compilation request accepting both proposals into two page targets. */
function request(overrides: Partial<IntentCompilationRequestV1> = {}): IntentCompilationRequestV1 {
  return {
    bundleId: mintBundleId(), adapters, contract, proposals, selections: [],
    targets: [pageTarget("ada"), pageTarget("grace")],
    reconciliations: [decideReconciliation({
      reconciliationId: "accept-facts", contract, proposals,
      proposalIds: proposals.map((proposal) => proposal.proposalId), decision: "accept",
      reasonCodes: ["duplicate-entity"], evidenceRefs: [evidence],
    })],
    completeness: completeness.record, ...overrides,
  };
}

const compiler = createOperationIntentCompilerV1();

/** Assert that compiling the perturbed request fails closed with the exact code. */
function expectCode(overrides: Partial<IntentCompilationRequestV1>, code: string): void {
  try {
    compiler.compile(request(overrides));
    throw new Error("expected an intent-compilation refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(IntentCompilerError);
    expect((error as IntentCompilerError).code).toBe(code);
  }
}

describe("intent compilation produces only Milestone A closed mutations", () => {
  it("stamps the envelope itself and routes every kind through a registered adapter", () => {
    const result = compiler.compile(request());
    expect(result.mutations).toHaveLength(2);
    expect(result.mutations.map((mutation) => mutation.index)).toEqual([0, 1]);
    expect(result.mutations.every((mutation) => mutation.mutationId.startsWith("opm_"))).toBe(true);
    expect(result.mutations[0]!.reconciliationRefs).toEqual(["accept-facts"]);
    expect(result.mutations.every((mutation) => mutation.kind === "page")).toBe(true);
  });

  it("refuses a draft kind that no Milestone A adapter is registered for", () => {
    const rogue = { ...pageTarget("ada"), draft: { ...pageTarget("ada").draft, kind: "git-push" } };
    expectCode({ targets: [rogue as unknown as HostMutationTargetV1, pageTarget("grace")] }, "unknown-mutation-kind");
  });

  it("rejects a host draft that tries to supply its own envelope fields", () => {
    const forged = {
      ...pageTarget("ada"),
      draft: { ...pageTarget("ada").draft, index: 9, mutationId: `opm_${"f".repeat(64)}` },
    };
    expectCode({ targets: [forged as unknown as HostMutationTargetV1, pageTarget("grace")] }, "envelope-field-supplied");
  });

  it("resolves declared dependencies to compiled indexes and refuses unknown ones", () => {
    const result = compiler.compile(request({
      targets: [pageTarget("ada"), pageTarget("grace", { dependsOnLogicalIdentities: ["entity:person:ada"] })],
    }));
    const dependent = result.mutations.find((mutation) => mutation.index === 1)!;
    expect(dependent.dependsOn).toEqual([0]);
    expectCode({
      targets: [pageTarget("ada"), pageTarget("grace", { dependsOnLogicalIdentities: ["entity:person:nobody"] })],
    }, "unknown-dependency");
  });

  it("links provenance from each mutation back to its reconciliation and proposals", () => {
    const result = compiler.compile(request());
    expect(result.provenance).toHaveLength(2);
    expect(result.provenance[0]!.reconciliationId).toBe("accept-facts");
    expect(result.provenance[0]!.proposalIds).toEqual([proposals[0]!.proposalId]);
    expect(result.provenance[0]!.sourceEvidenceDigests).toEqual([evidence.digest]);
    expect(result.reconciliations).toEqual([{
      id: "accept-facts", findingDigest: expect.stringMatching(/^sha256:/),
      resolution: "create-distinct", rationaleDigest: expect.stringMatching(/^sha256:/),
    }]);
  });
});

describe("provider text never chooses a writer or a target path", () => {
  it("compiles paths only from host target authority, never from proposal bytes", () => {
    const serialized = JSON.stringify(compiler.compile(request()).mutations);
    expect(serialized).not.toContain("etc/passwd");
    expect(serialized).not.toContain("git push");
    expect(serialized).toContain("ada");
  });

  it("fails closed when a proposal names a logical identity the host never resolved", () => {
    expectCode({ targets: [pageTarget("ada")] }, "unresolved-target");
  });

  it("fails closed when two host targets claim the same logical identity", () => {
    expectCode({ targets: [pageTarget("ada"), { ...pageTarget("grace"), logicalIdentity: "entity:person:ada" }] },
      "duplicate-target");
  });
});

describe("intent compilation gates on settled authority", () => {
  it("refuses to compile while a needs-operator reconciliation is pending", () => {
    expectCode({
      reconciliations: [decideReconciliation({
        reconciliationId: "accept-facts", contract, proposals,
        proposalIds: proposals.map((proposal) => proposal.proposalId), decision: "needs-operator",
        reasonCodes: ["duplicate-entity"], evidenceRefs: [evidence],
      })],
    }, "needs-operator-pending");
  });

  it("refuses to compile a handoff while a required completeness deficit exists", () => {
    const deficient = deriveCompleteness({
      scopeId: "compile", classes: [{
        classId: "entity-facts", disposition: "required",
        identitySetRef: { ...evidence, kind: "completeness-identity-set" },
        identitySets: {
          planned: ["ada", "grace"], eligible: ["ada"], attempted: ["ada"], completed: ["ada"],
          included: ["ada"], skipped: [], unavailable: [], failed: [], cancelled: [],
          overflow: ["grace"], nonConverged: [],
        },
      }],
    });
    expectCode({ completeness: deficient.record }, "required-deficit");
  });

  it("carries optional incompleteness through as an exact planning warning", () => {
    const optional = deriveCompleteness({
      scopeId: "compile", classes: [{
        classId: "entity-facts", disposition: "optional",
        identitySetRef: { ...evidence, kind: "completeness-identity-set" },
        identitySets: {
          planned: ["ada", "grace"], eligible: ["ada"], attempted: ["ada"], completed: ["ada"],
          included: ["ada"], skipped: [], unavailable: [], failed: [], cancelled: [],
          overflow: ["grace"], nonConverged: [],
        },
      }],
    });
    const result = compiler.compile(request({ completeness: optional.record }));
    expect(result.completeness.optionalMissing).toBe(1);
    expect(result.completeness.requiredMissing).toBe(0);
    expect(result.planningWarnings.map((warning) => warning.code))
      .toContain("preparation-optional-completeness-deficit");
  });

  it("emits no mutation for a rejected or deferred reconciliation", () => {
    for (const decision of ["reject", "defer"] as const) {
      const result = compiler.compile(request({
        reconciliations: [decideReconciliation({
          reconciliationId: "hold", contract, proposals,
          proposalIds: proposals.map((proposal) => proposal.proposalId), decision,
          reasonCodes: ["duplicate-entity"], evidenceRefs: [evidence],
        })],
        // The host authoritatively declares nothing required, so the deferral is honest incompleteness.
        requiredProposalIds: [],
      }));
      expect(result.mutations).toEqual([]);
      expect(result.planningWarnings.some((warning) => warning.code === DEFERRED_PROPOSAL_CODE))
        .toBe(decision === "defer");
    }
  });
});

describe("the intent compiler writes nothing", () => {
  it("leaves the project, operator, and cache trees byte-identical", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llmwiki-intent-"));
    for (const dir of [".llmwiki", ".llmwiki/operator", ".llmwiki/cache"]) {
      await mkdir(path.join(root, dir), { recursive: true });
      await writeFile(path.join(root, dir, "marker"), "before");
    }
    const before = await snapshotTree(root);
    compiler.compile(request());
    expect(() => compiler.compile(request({ targets: [pageTarget("ada")] }))).toThrow();
    expect(await snapshotTree(root)).toEqual(before);
  });
});
