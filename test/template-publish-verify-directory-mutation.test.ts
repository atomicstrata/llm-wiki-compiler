/**
 * @file test/template-publish-verify-directory-mutation.test.ts
 * @description Regression coverage for mutations of a directory inode while
 * its publisher distribution entries are being enumerated.
 */
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertExactDistributionTree,
  closeDistributionPaths,
  resolveDistributionPaths,
} from "../src/profile/templates/publish/filesystem.js";
import {
  createPublishDistribution,
  removePublishDistribution,
  type PublishDistribution,
} from "./fixtures/template-publish-distribution.js";

const fixtures: PublishDistribution[] = [];

afterEach(async () => Promise.all(fixtures.splice(0).map(removePublishDistribution)));

describe("publisher distribution directory mutation guard", () => {
  it("refuses an entry created and removed after opening the directory stream", async () => {
    const tree = await createPublishDistribution();
    fixtures.push(tree);
    const paths = await resolveDistributionPaths(tree.directory, {
      afterDirectoryStreamOpenForTest: async (directory, label) => {
        if (label !== "package digest directory") return;
        const transient = path.join(directory, "transient.json");
        await writeFile(transient, "{}", "utf8");
        await unlink(transient);
      },
    });
    try {
      await expect(assertExactDistributionTree(paths, [tree.envelope.payloadDigest]))
        .rejects.toThrow(/changed during enumeration/i);
    } finally {
      await closeDistributionPaths(paths);
    }
  });
});
