/**
 * @file test/capability-providers/custody-fail-closed.test.ts
 * @description P1/P2/P3 regression: the custody surface must fail closed. Any
 * I/O fault while enumerating the output root, reading an output, or retaining
 * evidence resolves to a closed `rejected` custody outcome — never a raw
 * rejected promise that would escape the invocation's closed-result contract and
 * be mistaken for "no unclaimed files".
 */
import path from "node:path";
import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createStreamingCustodian } from "../../src/capability-providers/runtime/custodian.js";
import { createEvidenceStore } from "../../src/capability-providers/runtime/evidence-store.js";
import { artifactClaim as claim, custodyOptions as options, useCustodyOutputRoots } from "./custody-fixture.js";

const { scratch, outputRoot } = useCustodyOutputRoots();
const TWO_DECLARED = [
  { outputId: "a", required: false, mediaType: "text/plain" },
  { outputId: "b", required: false, mediaType: "text/plain" },
];

describe("custody fails closed on I/O faults", () => {
  it("returns a closed rejected outcome when the output root cannot be enumerated (P1)", async () => {
    const missingRoot = `${await scratch("llmwiki-custody-")}/does-not-exist`;
    const custody = await createStreamingCustodian(options(missingRoot)).custody(claim("report", "report") as never);
    expect(custody).toMatchObject({ kind: "rejected" });
  });

  it("returns a closed rejected outcome when evidence retention faults (P2)", async () => {
    const root = await outputRoot({ report: "report-bytes" });
    const retainEvidence = async () => { throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" }); };
    const custody = await createStreamingCustodian(options(root, { retainEvidence })).custody(claim("report", "report") as never);
    expect(custody).toMatchObject({ kind: "rejected" });
  });

  it("returns a closed rejected outcome when evidence provisioning faults via the real store (P2)", async () => {
    const store = createEvidenceStore(`${await scratch("llmwiki-custody-")}/no-such-parent`);
    const root = await outputRoot({ report: "report-bytes" });
    const custody = await createStreamingCustodian(options(root, { retainEvidence: store.retain })).custody(claim("report", "report") as never);
    expect(custody).toMatchObject({ kind: "rejected" });
  });

  it("rolls back evidence written before an atomic rejection (P4)", async () => {
    const parent = await scratch("llmwiki-custody-host-");
    const store = createEvidenceStore(parent);
    const root = await outputRoot({ a: "alpha", b: "too-long-bytes" });
    const custody = await createStreamingCustodian(options(root, {
      declaredOutputs: TWO_DECLARED, maxOutputBytesById: new Map([["b", 4]]),
      retainEvidence: store.retain, discardEvidence: store.discard,
    })).custody({ artifactClaims: [{ outputId: "a", outputToken: "a" }, { outputId: "b", outputToken: "b" }] } as never);
    expect(custody).toMatchObject({ kind: "rejected" });
    const remaining = await readdir(path.join(parent, "accepted-evidence")).catch(() => [] as string[]);
    expect(remaining).toEqual([]);
  });
});
