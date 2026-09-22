/**
 * @file test/capability-providers/custody-bounds.test.ts
 * @description F2 regression: runtime custody must enforce the output namespace
 * and the resolved output bounds, not just visit provider-declared claims. An
 * unclaimed or non-regular file in the output root fails the whole result; a
 * single output exceeding its declared per-file maximum is rejected before its
 * bytes are allocated; the aggregate output-byte and output-file ceilings are
 * enforced; and wall-time is checked during the read, not only before it.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { symlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createStreamingCustodian } from "../../src/capability-providers/runtime/custodian.js";
import { artifactClaim as claim, custodyOptions as options, useCustodyOutputRoots } from "./custody-fixture.js";

const { outputRoot } = useCustodyOutputRoots();

const TWO_DECLARED = [
  { outputId: "a", required: false, mediaType: "text/plain" },
  { outputId: "b", required: false, mediaType: "text/plain" },
];
const TWO_CLAIMS = { artifactClaims: [{ outputId: "a", outputToken: "a" }, { outputId: "b", outputToken: "b" }] };

/** Custody a single "report" output under the given option overrides. */
const custodyReport = (root: string, overrides: Parameters<typeof options>[1] = {}) =>
  createStreamingCustodian(options(root, overrides)).custody(claim("report", "report") as never);

/** Custody the two-output "a"/"b" claim set under the given option overrides. */
const custodyTwo = (root: string, overrides: Parameters<typeof options>[1]) =>
  createStreamingCustodian(options(root, { declaredOutputs: TWO_DECLARED, ...overrides })).custody(TWO_CLAIMS as never);

describe("runtime custody output-namespace and bounds", () => {
  it("rejects the whole result when an unclaimed file is present in the output root", async () => {
    const root = await outputRoot({ report: "report-bytes", sneaky: "smuggled" });
    expect(await custodyReport(root)).toMatchObject({ kind: "rejected" });
  });

  it("rejects a non-regular entry in the output root", async () => {
    const root = await outputRoot({ report: "report-bytes" });
    await symlink("/etc/hosts", path.join(root, "link"));
    expect(await custodyReport(root)).toMatchObject({ kind: "rejected" });
  });

  it("rejects an output that exceeds its declared per-file maximum", async () => {
    const root = await outputRoot({ report: "x".repeat(64) });
    expect(await custodyReport(root, { maxOutputBytesById: new Map([["report", 16]]) })).toMatchObject({ kind: "rejected" });
  });

  it("rejects when the aggregate output-byte ceiling is exceeded", async () => {
    const root = await outputRoot({ a: "x".repeat(8), b: "y".repeat(8) });
    expect(await custodyTwo(root, { outputBytes: 12 })).toMatchObject({ kind: "rejected" });
  });

  it("rejects when the output-file count exceeds the ceiling", async () => {
    const root = await outputRoot({ a: "x", b: "y" });
    expect(await custodyTwo(root, { outputFiles: 1 })).toMatchObject({ kind: "rejected" });
  });

  it("exhausts the wall-time budget during a multi-chunk read", async () => {
    const root = await outputRoot({ report: "x".repeat(200_000) });
    let clock = 0;
    const now = () => (clock += 40);
    const custody = await custodyReport(root, { wallTimeMs: 50, scanBytes: 1_000_000, now });
    expect(custody).toMatchObject({ kind: "exhausted", dimension: "custodyWallTimeMs" });
  });

  it("still admits a sole claimed output within all bounds", async () => {
    const body = "report-bytes";
    const root = await outputRoot({ report: body });
    const custody = await custodyReport(root, {
      outputBytes: 1_000, outputFiles: 4, maxOutputBytesById: new Map([["report", 1_000]]),
    });
    expect(custody.kind).toBe("accepted");
    if (custody.kind === "accepted") {
      expect(custody.artifacts[0].digest).toBe(`sha256:${createHash("sha256").update(body).digest("hex")}`);
    }
  });
});
