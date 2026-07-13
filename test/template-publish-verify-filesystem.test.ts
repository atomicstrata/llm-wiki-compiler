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

  it("refuses package leaf symlinks without exposing outside bytes", async () => {
    const tree = await fixture();
    const outside = path.join(tree.root, "outside-secret.json");
    const secret = "OUTSIDE_PACKAGE_SECRET";
    await writeFile(outside, secret, "utf8");
    await rename(tree.packageFile, `${tree.packageFile}.real`);
    await symlink(outside, tree.packageFile);
    const result = runPublishVerify(tree);
    assertFailure(result, /symlink|regular file|no.follow/i);
    expect(diagnostics(result)).not.toContain(secret);
  });

  it("refuses a package directory symlink that escapes the selected tree", async () => {
    const tree = await fixture();
    const packageRoot = path.join(tree.directory, "packages");
    const moved = path.join(tree.root, "outside-packages");
    await rename(packageRoot, moved);
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

  it("refuses a special package file without blocking on it", async () => {
    const tree = await fixture();
    await rename(tree.packageFile, `${tree.packageFile}.real`);
    await makeFifo(tree.packageFile);
    assertFailure(runPublishVerify(tree), /regular file|special|fifo/i);
  });

  it("refuses an oversized package envelope", async () => {
    const tree = await fixture();
    await writeFile(tree.packageFile, `${JSON.stringify(tree.envelope)}${" ".repeat(2 * 1024 * 1024)}`, "utf8");
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
  expect(result.stdout).not.toContain('"verified": true');
  expect(result.stderr.length).toBeLessThanOrEqual(4096);
}
