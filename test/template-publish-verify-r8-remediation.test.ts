/**
 * @file test/template-publish-verify-r8-remediation.test.ts
 * @description Regression coverage for R8 root-binding, retained-directory,
 * and path-free tap-key failure remediation at production chokepoints.
 */
import { chmod, cp, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDistributionPaths,
  readDistributionIndex,
  resolveDistributionPaths,
} from "../src/profile/templates/publish/filesystem.js";
import { verifyPublisherDistribution } from "../src/profile/templates/publish/verify.js";
import { TAP_KEY } from "./fixtures/template-signing.js";
import {
  createPublishDistribution,
  diagnostics,
  removePublishDistribution,
  runPublishVerify,
  type PublishDistribution,
  type VerifyResult,
} from "./fixtures/template-publish-distribution.js";

const fixtures: PublishDistribution[] = [];
const permissionIt = it.skipIf(process.platform === "win32");
const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

afterEach(async () => Promise.all(fixtures.splice(0).map(removePublishDistribution)));

async function fixture(): Promise<PublishDistribution> {
  const tree = await createPublishDistribution();
  fixtures.push(tree);
  return tree;
}

describe("template publish verify R8 remediation", () => {
  it("refuses a valid-tree root swap restored after the pathname leaf opens", async () => {
    const tree = await fixture();
    const decoy = path.join(tree.root, "valid-decoy");
    const original = path.join(tree.root, "selected-original");
    await cp(tree.directory, decoy, { recursive: true });
    let swapped = false;
    const paths = await resolveDistributionPaths(tree.directory, {
      beforeLeafOpenForTest: async (_file, label) => {
        if (label !== "index" || swapped) return;
        await rename(tree.directory, original);
        await rename(decoy, tree.directory);
        swapped = true;
      },
      afterLeafOpenForTest: async (_file, label) => {
        if (label !== "index" || !swapped) return;
        await rename(tree.directory, decoy);
        await rename(original, tree.directory);
      },
    });
    try {
      await expect(readDistributionIndex(paths)).rejects.toThrow(/index|changed|confined|regular/i);
    } finally {
      await closeDistributionPaths(paths);
    }
  });

  it("refuses an extra package added after final exact-tree enumeration", async () => {
    const tree = await fixture();
    const extra = path.join(path.dirname(tree.packageFile), `${"b".repeat(64)}.json`);
    await expect(verifyPublisherDistribution(
      tree.directory,
      "official",
      TAP_KEY.keyId,
      tree.keyFile,
      { beforeFinalVerdictForTest: async () => writeFile(extra, "{}", "utf8") },
    )).rejects.toThrow(/changed during enumeration|directory.*changed|concurrent/i);
  });

  permissionIt.each([{ args: [] }, { args: ["--json"] }])(
    "keeps an unreadable long tap-key path private in mode $args",
    async ({ args }) => {
      const tree = await fixture();
      const secret = path.join(tree.root, `secret-\n\r\u001b-${"x".repeat(160)}`);
      await rename(tree.keyFile, secret);
      await chmod(secret, 0o000);

      const result = runPublishVerify(tree, args, TAP_KEY.keyId, secret);
      assertPrivateTapKeyFailure(result, secret);
    },
  );
});

function assertPrivateTapKeyFailure(result: VerifyResult, secret: string): void {
  const output = diagnostics(result);
  expect(result.status).not.toBe(0);
  expect(output).toMatch(/tap key file.*opened safely|unavailable/i);
  expect(output).not.toContain(secret);
  expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(4_096);
  expect(output.trim()).not.toMatch(TERMINAL_CONTROL);
}
