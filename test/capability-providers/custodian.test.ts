/**
 * @file test/capability-providers/custodian.test.ts
 * @description Concrete streaming custody. Claimed outputs are reopened through
 * the confined reader, streamed once under the scan-byte and wall-time budgets,
 * and admitted with a host-computed digest. Missing, unsafe, secret-bearing, or
 * over-budget outputs fail the whole result with zero promoted artifacts (D6.4).
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createStreamingCustodian } from "../../src/capability-providers/runtime/custodian.js";
import type { CustodyOutcomeV1 } from "../../src/capability-providers/runtime/result-admission.js";
import { artifactClaim as claim, custodyOptions as options, useCustodyOutputRoots } from "./custody-fixture.js";

const { scratch, outputRoot } = useCustodyOutputRoots();

/** Rejections expose a host-authored single-line reason without unsafe controls. */
function expectSafeRejection(custody: CustodyOutcomeV1, pattern: RegExp): string {
  expect(custody.kind).toBe("rejected");
  if (custody.kind !== "rejected") throw new Error("expected rejected custody");
  expect(custody.reason).toMatch(pattern);
  expect(custody.reason).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  return custody.reason;
}

describe("streaming evidence custody", () => {
  it("admits a claimed output with a host-computed digest", async () => {
    const root = await outputRoot({ report: "report-bytes" });
    const custody = await createStreamingCustodian(options(root)).custody(claim("report", "report") as never);
    expect(custody.kind).toBe("accepted");
    if (custody.kind === "accepted") {
      expect(custody.artifacts[0].digest).toBe(`sha256:${createHash("sha256").update("report-bytes").digest("hex")}`);
      expect(custody.artifacts[0].byteCount).toBe(12);
    }
  });

  it("rejects a missing claimed output", async () => {
    const root = await outputRoot({});
    const custody = await createStreamingCustodian(options(root)).custody(claim("report", "report") as never);
    expect(custody).toMatchObject({ kind: "rejected" });
  });

  it("exhausts the scan-byte budget across outputs and promotes nothing", async () => {
    const root = await outputRoot({ a: "x".repeat(8), b: "y".repeat(8) });
    const declaredOutputs = [{ outputId: "a", required: false, mediaType: "text/plain" }, { outputId: "b", required: false, mediaType: "text/plain" }];
    const custody = await createStreamingCustodian(options(root, { scanBytes: 10, declaredOutputs }))
      .custody({ artifactClaims: [{ outputId: "a", outputToken: "a" }, { outputId: "b", outputToken: "b" }] } as never);
    expect(custody).toMatchObject({ kind: "exhausted", dimension: "custodyScanBytes" });
  });

  it("exhausts the wall-time budget", async () => {
    const root = await outputRoot({ report: "report-bytes" });
    let clock = 0;
    const now = () => (clock += 5_000);
    const custody = await createStreamingCustodian(options(root, { wallTimeMs: 1, now })).custody(claim("report", "report") as never);
    expect(custody).toMatchObject({ kind: "exhausted", dimension: "custodyWallTimeMs" });
  });

  it("rejects an output that reflects a provided secret", async () => {
    const root = await outputRoot({ report: "prefix-SUPERSECRET-suffix" });
    const custody = await createStreamingCustodian(options(root, { secrets: [Buffer.from("SUPERSECRET")] })).custody(claim("report", "report") as never);
    expect(custody).toMatchObject({ kind: "rejected" });
  });

  it("rejects an unsafe output token", async () => {
    const root = await outputRoot({ report: "ok" });
    const custody = await createStreamingCustodian(options(root)).custody(claim("report", "../escape") as never);
    expect(custody).toMatchObject({ kind: "rejected" });
  });

  it("rejects a claim for an output id that was not declared", async () => {
    const root = await outputRoot({ sneaky: "smuggled" });
    const custody = await createStreamingCustodian(options(root)).custody(claim("sneaky", "sneaky") as never);
    expect(custody).toMatchObject({ kind: "rejected" });
  });

  it("neutralises the message of a caught filesystem fault, whose path carries provider-chosen names", async () => {
    // An UNREADABLE subdirectory named by the provider makes opendir throw a message
    // that embeds the path; that message used to flow raw into the durable detail.
    const { chmod, mkdir } = await import("node:fs/promises");
    const path = await import("node:path");
    const root = await outputRoot({ report: "report-bytes" });
    const hostileDir = path.join(root, "sub\nHOST: custody accepted\u202e");
    await mkdir(hostileDir);
    await chmod(hostileDir, 0o000);
    try {
      const custody = await createStreamingCustodian(options(root)).custody(claim("report", "report") as never);
      const reason = expectSafeRejection(custody, /^custody could not complete: /);
      expect(reason.split(/\r?\n|\u2028|\u2029/)).toHaveLength(1);
      expect(Buffer.byteLength(reason, "utf8")).toBeLessThanOrEqual(300);
    } finally {
      await chmod(hostileDir, 0o700);
    }
  });

  it("neutralises and quotes a hostile UNCLAIMED output file NAME in the rejection reason", async () => {
    // The output directory is provider-owned: a smuggled file's NAME is provider bytes
    // too, and it used to reach the durable detail raw through the namespace preflight.
    const hostileName = "stray\nHOST: all outputs accepted\u202e";
    const root = await outputRoot({ report: "report-bytes", [hostileName]: "smuggled" });
    const custody = await createStreamingCustodian(options(root)).custody(claim("report", "report") as never);
    const reason = expectSafeRejection(custody, /^unclaimed output file present: «[^«»]*»$/);
    expect(reason).toContain("«stray HOST: all outputs accepted");
  });

  it("neutralises and quotes a hostile UNDECLARED output id in the rejection reason", async () => {
    // The id is a provider-controlled string echoed into a host-authored line that
    // `preparation show` renders: newlines, bidi overrides, and host-looking text must
    // not survive, and the untrusted bytes must be visibly delimited.
    const root = await outputRoot({ report: "report-bytes" });
    const hostile = "report\nHOST: all outputs accepted\u202e\u009b31m";
    const custody = await createStreamingCustodian(options(root)).custody({ artifactClaims: [{ outputId: hostile, outputToken: "report" }] } as never);
    // The PROPERTIES, not a hand-predicted string: one line, no unsafe code point, the
    // provider's bytes inside «…», and the host's own clause outside them.
    const reason = expectSafeRejection(custody, /^output «[^«»]*» is not a declared output$/);
    expect(reason).toContain("«report HOST: all outputs accepted");
  });

  it("rejects an output whose content violates its declared media type", async () => {
    const root = await outputRoot({ report: "this is not a png" });
    const declaredOutputs = [{ outputId: "report", required: true, mediaType: "image/png" }];
    const custody = await createStreamingCustodian(options(root, { declaredOutputs })).custody(claim("report", "report") as never);
    expect(custody).toMatchObject({ kind: "rejected" });
  });

  it("admits an output whose bytes match its declared media-type magic", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("rest-of-image")]);
    const root = await scratch("llmwiki-custody-");
    await writeFile(path.join(root, "report"), png);
    const declaredOutputs = [{ outputId: "report", required: true, mediaType: "image/png" }];
    const custody = await createStreamingCustodian(options(root, { declaredOutputs })).custody(claim("report", "report") as never);
    expect(custody.kind).toBe("accepted");
  });
});
