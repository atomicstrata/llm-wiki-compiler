/**
 * @file test/capability-providers/result-admission.test.ts
 * @description Result admission drives completeness from host-observed custody,
 * never provider counters. A claim contradicting custody is output-invalid, a
 * missing required output is a typed partial, custody exhaustion fails the whole
 * result with zero artifacts, and untrusted provider evidence stays separated.
 */
import { describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import {
  admitProviderResult, type AcceptedArtifactV1, type CustodyOutcomeV1,
  type DeclaredArtifactOutputV1,
} from "../../src/capability-providers/runtime/result-admission.js";

function digest(seed: number) {
  return parseSha256Digest(`sha256:${seed.toString(16).padStart(2, "0").repeat(32)}`);
}

function accepted(outputId: string, byteCount: number): AcceptedArtifactV1 {
  return { outputId, mediaType: "application/json", digest: digest(byteCount), byteCount };
}

const DECLARED: readonly DeclaredArtifactOutputV1[] = [
  { outputId: "report", required: true, mediaType: "application/json" },
  { outputId: "notes", required: false, mediaType: "text/plain" },
];

function admit(custody: CustodyOutcomeV1, providerResult: Record<string, unknown>, declaredOutputs: readonly DeclaredArtifactOutputV1[] = DECLARED) {
  return admitProviderResult({
    custody, declaredOutputs, receipts: [],
    usage: { brokerRequestCount: 0, tokenCount: "unobserved", costMicros: "unobserved" },
    providerResult: providerResult as never,
  });
}

/** Check that partial-result detail preserves its host facts within the durable cap. */
function expectBoundedPartial(result: ReturnType<typeof admit>, pattern: RegExp): string {
  expect(result.outcome).toBe("partial");
  if (result.outcome !== "partial") throw new Error("expected partial result");
  expect(result.detail).toMatch(pattern);
  expect(Buffer.byteLength(result.detail, "utf8")).toBeLessThanOrEqual(512);
  return result.detail;
}

/** Admit a standard single-report success with an exact-matching claim plus extra fields. */
function admitReport(extra: Record<string, unknown> = {}) {
  const custody: CustodyOutcomeV1 = { kind: "accepted", artifacts: [accepted("report", 100)], scanBytes: 100 };
  return admit(custody, {
    artifactClaims: [{ outputId: "report", claimedDigest: digest(100), claimedByteCount: 100 }],
    ...extra,
  });
}

describe("provider result admission", () => {
  it("admits a result whose claims match custody", () => {
    const result = admitReport();
    expect(result.outcome).toBe("succeeded");
    if (result.outcome === "succeeded") expect(result.counts.acceptedArtifacts).toBe(1);
  });

  it("fails output-invalid when a claim contradicts custody bytes", () => {
    const custody: CustodyOutcomeV1 = { kind: "accepted", artifacts: [accepted("report", 100)], scanBytes: 100 };
    const result = admit(custody, {
      artifactClaims: [{ outputId: "report", claimedDigest: digest(100), claimedByteCount: 200 }],
    });
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") expect(result.problem).toBe("provider-output-invalid");
  });

  it("fails output-invalid when a claim names an unaccepted output", () => {
    const custody: CustodyOutcomeV1 = { kind: "accepted", artifacts: [], scanBytes: 0 };
    const result = admit(custody, {
      artifactClaims: [{ outputId: "report", claimedDigest: digest(1), claimedByteCount: 1 }],
    });
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") expect(result.problem).toBe("provider-output-invalid");
  });

  it("returns a typed partial when a required output is missing", () => {
    const custody: CustodyOutcomeV1 = { kind: "accepted", artifacts: [], scanBytes: 0 };
    const result = admit(custody, { artifactClaims: [] });
    expect(result.outcome).toBe("partial");
    if (result.outcome === "partial") expect(result.problem).toBe("provider-partial");
  });

  it("carries a provider-reported failure reason into the partial detail, labelled untrusted", () => {
    // A provider that ran and FAILED says so in its terminal result. Without this the
    // host line reads only "missing required outputs" — indistinguishable from a
    // toolchain that never ran — and the reason the provider actually saw is lost.
    const custody: CustodyOutcomeV1 = { kind: "accepted", artifacts: [], scanBytes: 0 };
    const result = admit(custody, {
      outcome: "failed", artifactClaims: [],
      detail: "latexmk failed after 3 rounds: ! LaTeX Error: File `pgfplots.sty' not found.",
    });
    expect(result.outcome).toBe("partial");
    if (result.outcome !== "partial") return;
    expect(result.problem).toBe("provider-partial"); // the host classification is unchanged
    expect(result.detail).toMatch(/^missing required outputs \(1\): report; provider reported failure \(untrusted\): latexmk failed after 3 rounds: /);
  });

  it("collapses newlines and terminal controls in the provider's reason to ONE printable line", () => {
    // The field renders as host-authored text: a provider must not mint follow-on lines
    // or terminal escapes inside it. Classification stays the host's either way.
    const custody: CustodyOutcomeV1 = { kind: "accepted", artifacts: [], scanBytes: 0 };
    // ASCII controls AND the Unicode ones a terminal or renderer honours: a bare C1 CSI
    // (U+009B), the line separator (U+2028), and a bidi override (U+202E).
    const result = admit(custody, {
      outcome: "failed", artifactClaims: [],
      detail: "latexmk failed\nFAKE HOST LINE: all outputs ok\x1b[31m\r\t!\u009b31m\u2028SECOND LINE\u202eDESREVER",
    });
    expect(result.outcome).toBe("partial");
    if (result.outcome !== "partial") return;
    // The PROPERTIES, not a hand-predicted string: no control character survives, the
    // injected "host line" stays INSIDE the labelled provider text on the same line, and
    // the host's own clause still terminates the detail.
    expect(result.detail).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(result.detail.split(/\r?\n|\u2028|\u2029/)).toHaveLength(1);
    expect(result.detail).toContain("SECOND LINE"); // kept as TEXT, on the same line
    expect(result.detail).toMatch(/^missing required outputs \(1\): report; provider reported failure \(untrusted\): latexmk failed FAKE HOST LINE: all outputs ok/);
  });

  it("keeps the host's missing-output fact inside the 512-byte durable cap however long or multibyte the provider's reason is", () => {
    // The leg detail is capped at 512 UTF-8 bytes downstream. A reason bounded in code
    // units would let 400 three-byte characters crowd the host fact out of the record;
    // the host clause comes FIRST and the fragment is bounded in BYTES, so the composed
    // detail fits by construction and truncation can only ever cut provider text.
    const custody: CustodyOutcomeV1 = { kind: "accepted", artifacts: [], scanBytes: 0 };
    const result = admit(custody, { outcome: "failed", artifactClaims: [], detail: "編".repeat(400) });
    const detail = expectBoundedPartial(result, /^missing required outputs \(1\): report; provider reported failure \(untrusted\): 編/);
    expect(detail).not.toContain("\uFFFD"); // the byte cut never leaves a torn code point
  });

  it("keeps the host's missing-output FACT whole under the cap even when a manifest declares 128 outputs of 128-byte ids", () => {
    // The bare id list could reach ~16 KB, so the durable 512-byte cap would cut HOST
    // text. The count is always stated, ids are listed until a byte budget is spent,
    // the rest is counted, and the untrusted fragment still fits after it.
    const many: DeclaredArtifactOutputV1[] = Array.from({ length: 128 }, (_, index) =>
      ({ outputId: `${"o".repeat(124)}${String(index).padStart(4, "0")}`, required: true, mediaType: "application/json" }));
    const custody: CustodyOutcomeV1 = { kind: "accepted", artifacts: [], scanBytes: 0 };
    const result = admit(custody, { outcome: "failed", artifactClaims: [], detail: "latexmk failed: reason" }, many);
    expectBoundedPartial(result, /^missing required outputs \(128\): o{124}0000, \+127 more; provider reported failure \(untrusted\): latexmk failed: reason$/);
  });

  it("neutralises and quotes a hostile output id in a duplicate-claim rejection", () => {
    // Admission's own reasons echo provider claim ids too; same class, same home.
    const hostile = "report\u2028FORGED HOST LINE\x1b[0m";
    const custody: CustodyOutcomeV1 = { kind: "accepted", artifacts: [accepted("report", 100)], scanBytes: 100 };
    const result = admit(custody, { artifactClaims: [
      { outputId: hostile, claimedDigest: digest(100), claimedByteCount: 100 },
      { outputId: hostile, claimedDigest: digest(100), claimedByteCount: 100 },
    ] });
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") return;
    // Whichever admission check fires first, the id is echoed only neutralised and quoted.
    expect(result.detail).toMatch(/^(?:duplicate artifact claim for|claimed output) «[^«»]*»/);
    expect(result.detail).toContain("«report FORGED HOST LINE");
    expect(result.detail.split(/\r?\n|\u2028|\u2029/)).toHaveLength(1);
    expect(result.detail).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  });

  it("appends NO provider text when the provider reported success or gave no detail", () => {
    const custody: CustodyOutcomeV1 = { kind: "accepted", artifacts: [], scanBytes: 0 };
    for (const providerResult of [{ artifactClaims: [] }, { outcome: "failed", artifactClaims: [], detail: "   " }]) {
      const result = admit(custody, providerResult);
      expect(result.outcome).toBe("partial");
      if (result.outcome === "partial") expect(result.detail).toBe("missing required outputs (1): report");
    }
  });

  it("fails resource-exhausted with no artifacts when custody exhausts", () => {
    const custody: CustodyOutcomeV1 = { kind: "exhausted", dimension: "custodyScanBytes" };
    const result = admit(custody, {
      artifactClaims: [{ outputId: "report", claimedDigest: digest(100), claimedByteCount: 100 }],
    });
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") expect(result.problem).toBe("provider-resource-exhausted");
  });

  it("keeps provider counts and warnings in the untrusted report only", () => {
    const result = admitReport({ providerReportedCounts: { completed: 999 }, warnings: [{ code: "w" }] });
    expect(result.untrusted.untrusted).toBe(true);
    expect(result.untrusted.providerReportedCounts).toEqual({ completed: 999 });
    expect(result.outcome).toBe("succeeded-with-warnings");
  });

  it("ignores a lying provider count that overstates completeness", () => {
    const result = admitReport({ providerReportedCounts: { completed: 500, attempted: 500 } });
    if (result.outcome === "succeeded" || result.outcome === "succeeded-with-warnings") {
      expect(result.counts.acceptedArtifacts).toBe(1);
      expect(result.counts.declared).toBe(2);
    }
  });

  it("rejects a malformed artifact claim list", () => {
    const custody: CustodyOutcomeV1 = { kind: "accepted", artifacts: [accepted("report", 100)], scanBytes: 100 };
    const result = admit(custody, { artifactClaims: "not-a-list" });
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") expect(result.problem).toBe("provider-output-invalid");
  });
});
