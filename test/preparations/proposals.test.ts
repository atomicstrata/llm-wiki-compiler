/**
 * @file test/preparations/proposals.test.ts
 * @description Provider output becomes BOUNDED PROPOSAL EVIDENCE ONLY (design
 * section 21.1). These fixtures are the adversarial half of the plan's Task 7
 * checklist: a provider draft that injects a path, mutation JSON, a writer, a
 * shell/Git command, a network target, an unknown kind, or a Milestone A mutation
 * kind must fail closed, and normalization must write nothing.
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROPOSAL_DRAFT_KEYS, ProposalAuthorityError, normalizeProviderProposals,
  type ProposalNormalizeInputV1,
} from "../../src/preparations/proposals.js";
import {
  SelectionAuthorityError, capturePolicyContract, type PreparationPolicyContractV1,
} from "../../src/preparations/selection.js";
import type { EvidenceRefV1, Sha256Digest } from "../../src/preparations/types.js";
import type { AttemptId } from "../../src/preparations/ids.js";
import { snapshotTree } from "./inputs-fixture.js";

const HANDLER_DIGEST = `sha256:${"7".repeat(64)}` as Sha256Digest;
const PROVIDER_PIN = `sha256:${"8".repeat(64)}` as Sha256Digest;
const ATTEMPT = `pat_${"9".repeat(64)}` as AttemptId;

const sourceRef: EvidenceRefV1 = {
  kind: "provider-output", mediaType: "application/json", provenanceLabel: "provider-output",
  digest: parseSha256Digest(`sha256:${"5".repeat(64)}`), byteCount: 256, sensitivity: "ordinary", retention: "until-handoff",
  producer: { kind: "provider", providerPinDigest: PROVIDER_PIN, attemptId: ATTEMPT }, untrusted: true,
};

const contract = capturePolicyContract({
  resolve: (): PreparationPolicyContractV1 => ({
    handlerId: "extract-facts", handlerContractVersion: "2.1.0", handlerContractDigest: HANDLER_DIGEST,
    exclusionReasonCodes: ["below-rank-limit"], reconciliationReasonCodes: ["duplicate-entity"],
    proposalKinds: ["entity-fact", "entity-alias"],
  }),
}, { handlerId: "extract-facts", handlerContractVersion: "2.1.0", handlerContractDigest: HANDLER_DIGEST });

/** Build one normalize request over the given untrusted provider drafts. */
function request(drafts: unknown, overrides: Partial<ProposalNormalizeInputV1> = {}): ProposalNormalizeInputV1 {
  return {
    contract, attemptId: ATTEMPT, providerPinDigest: PROVIDER_PIN,
    sourceEvidenceRefs: [sourceRef], drafts, ...overrides,
  };
}

/** One well-formed provider draft the host is allowed to normalize. */
function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposalKind: "entity-fact", targetLogicalIdentity: "entity:person:ada-lovelace",
    proposedValue: { field: "birthYear", value: 1815 }, ...overrides,
  };
}

/** Assert that normalizing the given drafts fails closed with the exact code. */
function expectCode(drafts: unknown, code: string, overrides: Partial<ProposalNormalizeInputV1> = {}): void {
  try {
    normalizeProviderProposals(request(drafts, overrides));
    throw new Error("expected a proposal refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(ProposalAuthorityError);
    expect((error as ProposalAuthorityError).code).toBe(code);
  }
}

describe("provider proposals are bounded evidence", () => {
  it("closes the draft key vocabulary to the three declared fields", () => {
    expect([...PROPOSAL_DRAFT_KEYS]).toEqual(["proposalKind", "targetLogicalIdentity", "proposedValue"]);
  });

  it("normalizes a valid draft into immutable host-identified evidence", () => {
    const [proposal] = normalizeProviderProposals(request([draft()]));
    expect(Object.keys(proposal!).sort()).toEqual([
      "proposalId", "proposalKind", "proposedValueDigest", "provenanceDigest",
      "schemaVersion", "sourceEvidenceRefs", "targetLogicalIdentity",
    ]);
    expect(proposal!.proposalId).toMatch(/^ppl_[0-9a-f]{64}$/);
    expect(Object.isFrozen(proposal)).toBe(true);
  });

  it("derives the value digest from the captured bytes, not from the provider", () => {
    const [first] = normalizeProviderProposals(request([draft()]));
    const [second] = normalizeProviderProposals(request([draft({ proposedValue: { field: "birthYear", value: 1816 } })]));
    expect(second!.proposedValueDigest).not.toBe(first!.proposedValueDigest);
    expectCode([draft({ proposedValueDigest: `sha256:${"0".repeat(64)}` })], "invalid-proposal");
    expectCode([draft({ provenanceDigest: `sha256:${"0".repeat(64)}` })], "invalid-proposal");
    expectCode([draft({ proposalId: "ppl_forged" })], "invalid-proposal");
  });

  it("binds provenance to the host-observed attempt and provider pin", () => {
    const [proposal] = normalizeProviderProposals(request([draft()]));
    const other = normalizeProviderProposals(request([draft()], { providerPinDigest: HANDLER_DIGEST }));
    expect(other[0]!.provenanceDigest).not.toBe(proposal!.provenanceDigest);
  });
});

describe("provider proposals can never choose a writer or a path", () => {
  it("rejects a draft that injects a filesystem path, writer, or command key", () => {
    for (const key of ["path", "targetPath", "writer", "command", "payloadRef", "mutation", "url"]) {
      expectCode([draft({ [key]: "anything" })], "invalid-proposal");
    }
  });

  it("rejects a target identity that is a path, traversal, or URL rather than a logical id", () => {
    for (const target of [
      "../../etc/passwd", "/etc/passwd", "wiki/pages/x.md", "C:\\Windows\\system32",
      "file:///etc/passwd", "https://example.com/x", "entity:\u0000null", "",
    ]) {
      expectCode([draft({ targetLogicalIdentity: target })], "invalid-target-identity");
    }
  });

  it("keeps injected mutation JSON as inert data with no writer-selecting fields", () => {
    const [proposal] = normalizeProviderProposals(request([draft({
      proposedValue: {
        kind: "page", operation: "create", payloadRef: "sha256:deadbeef",
        target: { kind: "raw", directory: "../../..", slug: "pwned" },
      },
    })]));
    expect(Object.keys(proposal!)).not.toContain("kind");
    expect(Object.keys(proposal!)).not.toContain("target");
    expect(proposal!.proposalKind).toBe("entity-fact");
    expect(JSON.stringify(proposal)).not.toContain("pwned");
  });

  it("rejects an unknown proposal kind and a Milestone A mutation kind alike", () => {
    expectCode([draft({ proposalKind: "git-push" })], "unknown-proposal-kind");
    expectCode([draft({ proposalKind: "shell-command" })], "unknown-proposal-kind");
    // A contract declaring a Milestone A mutation kind is refused at the EARLIER
    // boundary: normalization re-captures the contract before reading a draft.
    const forged = { ...contract, proposalKinds: ["page", "relation"] } as PreparationPolicyContractV1;
    try {
      normalizeProviderProposals(request([draft({ proposalKind: "page" })], { contract: forged }));
      throw new Error("expected a contract refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(SelectionAuthorityError);
      expect((error as SelectionAuthorityError).code).toBe("mutation-kind-proposal");
    }
  });

  it("refuses provider drafts delivered through accessors or a hostile prototype", () => {
    const hostile: Record<string, unknown> = { proposalKind: "entity-fact", targetLogicalIdentity: "entity:x" };
    Object.defineProperty(hostile, "proposedValue", { get: () => ({ a: 1 }), enumerable: true });
    expectCode([hostile], "invalid-proposal");
    expectCode([Object.assign(Object.create({ evil: true }), draft())], "invalid-proposal");
    expectCode(new Proxy([draft()], {}), "invalid-proposal");
  });
});

describe("provider proposals are bounded and inert", () => {
  it("caps the proposal count and the canonical value size", () => {
    const many = Array.from({ length: 4 }, (_unused, index) => draft({ targetLogicalIdentity: `entity:x-${index}` }));
    expectCode(many, "proposal-cap-exceeded", { maximumProposals: 3 });
    expectCode([draft({ proposedValue: { blob: "z".repeat(200_000) } })], "proposal-too-large");
  });

  it("rejects two drafts that normalize to the same host identity", () => {
    expectCode([draft(), draft()], "duplicate-proposal");
  });

  it("requires at least one host-copied source evidence reference", () => {
    expectCode([draft()], "missing-evidence", { sourceEvidenceRefs: [] });
  });

  it("writes nothing while normalizing a hostile draft set", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llmwiki-proposals-"));
    await mkdir(path.join(root, ".llmwiki"), { recursive: true });
    await writeFile(path.join(root, ".llmwiki", "marker"), "before");
    const before = await snapshotTree(root);
    expect(() => normalizeProviderProposals(request([draft({ path: `${root}/pwned` })]))).toThrow();
    normalizeProviderProposals(request([draft()]));
    expect(await snapshotTree(root)).toEqual(before);
  });
});
