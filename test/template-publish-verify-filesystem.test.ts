/**
 * @file test/template-publish-verify-filesystem.test.ts
 * @description Frozen Slice A filesystem oracle for bounded, no-follow,
 * path-confined, complete static-tree verification.
 */
import { rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeFifo } from "./fixtures/fifo.js";
import { COORDINATE, signedPackage, signedTapRotation, signedRotation, TAP_KEY } from "./fixtures/template-signing.js";
import {
  createPublishDistribution,
  diagnostics,
  removePublishDistribution,
  runPublishVerify,
  writeSignedDistributionIndex,
  type PublishDistribution,
  type VerifyResult,
} from "./fixtures/template-publish-distribution.js";

const fixtures: PublishDistribution[] = [];
const fifoIt = it.skipIf(process.platform === "win32");
const OVERSIZED_INPUT_BYTES = 2 * 1024 * 1024;

async function fixture(): Promise<PublishDistribution> {
  const value = await createPublishDistribution();
  fixtures.push(value);
  return value;
}

afterEach(async () => Promise.all(fixtures.splice(0).map(removePublishDistribution)));

describe("template publish verify filesystem hardening", () => {
  it("refuses a missing referenced package", async () => {
    const tree = await fixture();
    await rename(tree.packageFile, `${tree.packageFile}.missing`);
    assertFailure(runPublishVerify(tree), /missing|package/i);
  });

  it("refuses unreferenced JSON package files", async () => {
    const tree = await fixture();
    const extra = path.join(path.dirname(tree.packageFile), `${"b".repeat(64)}.json`);
    await writeFile(extra, JSON.stringify(signedPackage()), "utf8");
    assertFailure(runPublishVerify(tree), /extra|unreferenced|unexpected/i);
  });

  it("refuses two signed entries that alias the same digest path", async () => {
    const tree = await fixture();
    await writeSignedDistributionIndex(tree, { packages: [
      tree.index.packages[0],
      { ...tree.index.packages[0], coordinate: COORDINATE.replace("@1.0.0", "@1.0.1") },
    ] });
    assertFailure(runPublishVerify(tree), /duplicate|alias|same package path/i);
  });

  fifoIt("refuses package leaf symlinks without reading outside the selected tree", async () => {
    const tree = await fixture();
    const outside = path.join(tree.root, "outside-blocking-package");
    await makeFifo(outside);
    await rename(tree.packageFile, `${tree.packageFile}.real`);
    await symlink(outside, tree.packageFile);
    assertFailure(runPublishVerify(tree), /symlink|regular file|no.follow/i);
  });

  fifoIt("refuses a package directory symlink that escapes the selected tree", async () => {
    const tree = await fixture();
    const packageRoot = path.join(tree.directory, "packages");
    const moved = path.join(tree.root, "outside-packages");
    await rename(packageRoot, moved);
    const outsidePackage = path.join(moved, "sha256", path.basename(tree.packageFile));
    await rename(outsidePackage, `${outsidePackage}.real`);
    await makeFifo(outsidePackage);
    await symlink(moved, packageRoot, "dir");
    assertFailure(runPublishVerify(tree), /symlink|escape|confined|regular/i);
  });

  it("refuses symlinked index and key inputs", async () => {
    const tree = await fixture();
    const index = path.join(tree.directory, "index.json");
    await rename(index, `${index}.real`);
    await symlink(`${index}.real`, index);
    assertFailure(runPublishVerify(tree), /index.*symlink|symlink.*index|no.follow/i);
    const second = await fixture();
    const key = path.join(second.root, "key-link.txt");
    await symlink(second.keyFile, key);
    assertFailure(runPublishVerify(second, [], TAP_KEY.keyId, key), /key.*symlink|symlink.*key|no.follow/i);
  });

  fifoIt("refuses a special index file without blocking on it", async () => {
    const tree = await fixture();
    const index = path.join(tree.directory, "index.json");
    await rename(index, `${index}.real`);
    await makeFifo(index);
    assertFailure(runPublishVerify(tree), /regular file|special|fifo/i);
  });

  fifoIt("refuses a special key file without blocking on it", async () => {
    const tree = await fixture();
    await rename(tree.keyFile, `${tree.keyFile}.real`);
    await makeFifo(tree.keyFile);
    assertFailure(runPublishVerify(tree), /regular file|special|fifo/i);
  });

  fifoIt("refuses a special package file without blocking on it", async () => {
    const tree = await fixture();
    await rename(tree.packageFile, `${tree.packageFile}.real`);
    await makeFifo(tree.packageFile);
    assertFailure(runPublishVerify(tree), /regular file|special|fifo/i);
  });

  it("refuses an oversized package envelope", async () => {
    const tree = await fixture();
    await writeFile(tree.packageFile, `${JSON.stringify(tree.envelope)}${" ".repeat(OVERSIZED_INPUT_BYTES)}`, "utf8");
    assertFailure(runPublishVerify(tree), /large|size|limit|bounded/i);
  });

  it("refuses an oversized otherwise-valid index", async () => {
    const tree = await fixture();
    const index = path.join(tree.directory, "index.json");
    await writeFile(index, `${JSON.stringify(tree.index)}${" ".repeat(OVERSIZED_INPUT_BYTES)}`, "utf8");
    assertFailure(runPublishVerify(tree), /large|size|limit|bounded/i);
  });

  it("refuses an oversized otherwise-valid key file", async () => {
    const tree = await fixture();
    await writeFile(tree.keyFile, `${TAP_KEY.publicKey}\n${" ".repeat(OVERSIZED_INPUT_BYTES)}`, "utf8");
    assertFailure(runPublishVerify(tree), /large|size|limit|bounded/i);
  });

  it("refuses publisher and tap-key rotations as unverifiable snapshot continuity", async () => {
    const publisherTree = await fixture();
    await writeSignedDistributionIndex(publisherTree, { rotations: [signedRotation()] });
    assertFailure(runPublishVerify(publisherTree), /continuity|rotation.*snapshot|snapshot.*rotation/i);
    const tapTree = await fixture();
    await writeSignedDistributionIndex(tapTree, { tapKeyRotation: signedTapRotation() });
    assertFailure(runPublishVerify(tapTree), /continuity|rotation.*snapshot|snapshot.*rotation/i);
  });
});

function assertFailure(result: VerifyResult, reason: RegExp): void {
  const output = diagnostics(result);
  expect(result.status).not.toBe(0);
  expect(output).toMatch(reason);
  expect(output).not.toMatch(/unknown command ['"]?publish|TypeError|ReferenceError|\n\s+at /i);
  expect(result.stdout).not.toMatch(/"verified"\s*:\s*true/);
  expect(result.stderr.length).toBeLessThanOrEqual(4096);
}
