/**
 * @file test/template-publish-verify-sibling-churn.test.ts
 * @description The distribution root's PARENT lies outside the distribution and
 * outside the trust boundary. Unrelated activity there (a concurrent download, an
 * editor swap file, another job in a shared temp dir) bumps the parent's ctime and
 * must NOT refuse a valid distribution. The paired control proves the relaxation is
 * scoped: an entry appearing INSIDE the distribution root still refuses, because the
 * root's own ctime remains a tracked mutation signal.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPublisherDistribution } from "../src/profile/templates/publish/verify.js";
import { TAP_KEY } from "./fixtures/template-signing.js";
import {
  createPublishDistribution,
  removePublishDistribution,
  type PublishDistribution,
} from "./fixtures/template-publish-distribution.js";

const fixtures: PublishDistribution[] = [];

afterEach(async () => Promise.all(fixtures.splice(0).map(removePublishDistribution)));

/** Verify one fixture, mutating the filesystem inside the retained-guard window. */
function verifyWhile(tree: PublishDistribution, mutate: () => Promise<void>): Promise<unknown> {
  return verifyPublisherDistribution(
    tree.directory,
    "official",
    TAP_KEY.keyId,
    tree.keyFile,
    { beforeFinalVerdictForTest: mutate },
  );
}

describe("publisher distribution sibling churn", () => {
  it("verifies while unrelated files appear beside the distribution root", async () => {
    const tree = await createPublishDistribution();
    fixtures.push(tree);
    const outside = path.dirname(tree.directory);

    await expect(verifyWhile(tree, async () => {
      await writeFile(path.join(outside, "unrelated-download.part"), "noise", "utf8");
      await mkdir(path.join(outside, "unrelated-directory"), { recursive: true });
    })).resolves.toMatchObject({ verified: true, scope: "snapshot" });
  });

  it("still refuses an entry that appears inside the distribution root", async () => {
    const tree = await createPublishDistribution();
    fixtures.push(tree);

    await expect(verifyWhile(tree, async () => {
      await writeFile(path.join(tree.directory, "smuggled.json"), "{}", "utf8");
    })).rejects.toThrow(/changed during enumeration/i);
  });
});
