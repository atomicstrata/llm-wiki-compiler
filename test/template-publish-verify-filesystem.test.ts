/**
 * @file test/template-publish-verify-filesystem.test.ts
 * @description Frozen Slice A filesystem oracle for bounded, no-follow,
 * path-confined, complete static-tree verification.
 */
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { makeFifo } from "./fixtures/fifo.js";
import { COORDINATE, signedPackage, signedTapRotation, signedRotation, TAP_KEY } from "./fixtures/template-signing.js";
import {
  assertPublishVerifyFailure,
  createPublishDistribution,
  removePublishDistribution,
  runPublishVerify,
  writeSignedDistributionIndex,
  type PublishDistribution,
} from "./fixtures/template-publish-distribution.js";
import { resolveDistributionPaths } from "../src/profile/templates/publish/filesystem.js";

const fixtures: PublishDistribution[] = [];
const fifoIt = it.skipIf(process.platform === "win32");
const OVERSIZED_PACKAGE_BYTES = 2 * 1024 * 1024;
const OVERSIZED_INDEX_BYTES = 4 * 1024 * 1024;
const OVERSIZED_KEY_BYTES = 64 * 1024;

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
    assertPublishVerifyFailure(runPublishVerify(tree), /missing|package/i);
  });

  it("refuses unreferenced JSON package files", async () => {
    const tree = await fixture();
    const extra = path.join(path.dirname(tree.packageFile), `${"b".repeat(64)}.json`);
    await writeFile(extra, JSON.stringify(signedPackage()), "utf8");
    assertPublishVerifyFailure(runPublishVerify(tree), /extra|unreferenced|unexpected/i);
  });

  it("refuses unreferenced regular files at every static-tree level", async () => {
    for (const relative of ["rogue.json", path.join("packages", "rogue.json")]) {
      const tree = await fixture();
      await writeFile(path.join(tree.directory, relative), JSON.stringify(signedPackage()), "utf8");
      assertPublishVerifyFailure(runPublishVerify(tree), /extra|unreferenced|unexpected/i);
    }
  });

  it("refuses nested files, unexpected directories, and unreferenced symlinks", async () => {
    const nestedTree = await fixture();
    const nested = path.join(path.dirname(nestedTree.packageFile), "nested");
    await mkdir(nested);
    await writeFile(path.join(nested, "extra.json"), JSON.stringify(signedPackage()), "utf8");
    assertPublishVerifyFailure(runPublishVerify(nestedTree), /extra|unreferenced|unexpected|directory/i);

    const directoryTree = await fixture();
    await mkdir(path.join(directoryTree.directory, "unexpected"));
    assertPublishVerifyFailure(runPublishVerify(directoryTree), /extra|unreferenced|unexpected|directory/i);

    const symlinkTree = await fixture();
    const extra = path.join(path.dirname(symlinkTree.packageFile), `${"b".repeat(64)}.json`);
    await symlink(symlinkTree.keyFile, extra);
    assertPublishVerifyFailure(runPublishVerify(symlinkTree), /extra|unreferenced|unexpected|symlink/i);
  });

  fifoIt("refuses an unreferenced special file during complete traversal", async () => {
    const tree = await fixture();
    const extra = path.join(path.dirname(tree.packageFile), `${"b".repeat(64)}.json`);
    await makeFifo(extra);
    assertPublishVerifyFailure(runPublishVerify(tree), /extra|unreferenced|unexpected|special|fifo/i);
  });

  it("refuses a symlinked distribution root", async () => {
    const tree = await fixture();
    const moved = path.join(tree.root, "actual-dist");
    await rename(tree.directory, moved);
    await symlink(moved, tree.directory, "dir");
    assertPublishVerifyFailure(runPublishVerify(tree), /root|symlink|escape|confined|directory/i);
  });

  it("refuses a distribution root swapped after its no-follow handle is opened", async () => {
    const tree = await fixture();
    const moved = `${tree.directory}.moved`;
    await expect(resolveDistributionPaths(tree.directory, {
      afterRootOpenForTest: async () => {
        await rename(tree.directory, moved);
        await symlink(moved, tree.directory, "dir");
      },
    })).rejects.toThrow(/root|symlink|changed|confined/i);
  });

  it("refuses two signed entries that alias the same digest path", async () => {
    const tree = await fixture();
    await writeSignedDistributionIndex(tree, { packages: [
      tree.index.packages[0],
      { ...tree.index.packages[0], coordinate: COORDINATE.replace("@1.0.0", "@1.0.1") },
    ] });
    assertPublishVerifyFailure(runPublishVerify(tree), /duplicate|alias|same package path/i);
  });

  it("refuses package leaf symlinks that point outside the selected tree", async () => {
    const tree = await fixture();
    const outside = path.join(tree.root, "outside-package.json");
    await rename(tree.packageFile, outside);
    await symlink(outside, tree.packageFile);
    assertPublishVerifyFailure(runPublishVerify(tree), /symlink|regular file|no.follow/i);
  });

  it("refuses a package directory symlink that escapes the selected tree", async () => {
    const tree = await fixture();
    const packageRoot = path.join(tree.directory, "packages");
    const moved = path.join(tree.root, "outside-packages");
    await rename(packageRoot, moved);
    await symlink(moved, packageRoot, "dir");
    assertPublishVerifyFailure(runPublishVerify(tree), /symlink|escape|confined|regular/i);
  });

  it("refuses an intermediate digest-directory symlink that escapes the selected tree", async () => {
    const tree = await fixture();
    const digestDirectory = path.dirname(tree.packageFile);
    const moved = path.join(tree.root, "outside-sha256");
    await rename(digestDirectory, moved);
    await symlink(moved, digestDirectory, "dir");
    assertPublishVerifyFailure(runPublishVerify(tree), /symlink|escape|confined|regular/i);
  });

  fifoIt("does not follow a package symlink to a blocking outside file", async () => {
    const tree = await fixture();
    const outside = path.join(tree.root, "outside-blocking-package");
    await makeFifo(outside);
    await rename(tree.packageFile, `${tree.packageFile}.real`);
    await symlink(outside, tree.packageFile);
    assertPublishVerifyFailure(runPublishVerify(tree), /symlink|regular file|no.follow/i);
  });

  it("refuses symlinked index and key inputs", async () => {
    const tree = await fixture();
    const index = path.join(tree.directory, "index.json");
    await rename(index, `${index}.real`);
    await symlink(`${index}.real`, index);
    assertPublishVerifyFailure(runPublishVerify(tree), /index.*symlink|symlink.*index|no.follow/i);
    const second = await fixture();
    const key = path.join(second.root, "key-link.txt");
    await symlink(second.keyFile, key);
    assertPublishVerifyFailure(runPublishVerify(second, [], TAP_KEY.keyId, key), /key.*symlink|symlink.*key|no.follow/i);
  });

  fifoIt("refuses a special index file without blocking on it", async () => {
    const tree = await fixture();
    const index = path.join(tree.directory, "index.json");
    await rename(index, `${index}.real`);
    await makeFifo(index);
    assertPublishVerifyFailure(runPublishVerify(tree), /regular file|special|fifo/i);
  });

  fifoIt("refuses a special key file without blocking on it", async () => {
    const tree = await fixture();
    await rename(tree.keyFile, `${tree.keyFile}.real`);
    await makeFifo(tree.keyFile);
    assertPublishVerifyFailure(runPublishVerify(tree), /regular file|special|fifo/i);
  });

  fifoIt("refuses a special package file without blocking on it", async () => {
    const tree = await fixture();
    await rename(tree.packageFile, `${tree.packageFile}.real`);
    await makeFifo(tree.packageFile);
    assertPublishVerifyFailure(runPublishVerify(tree), /regular file|special|fifo/i);
  });

  it("refuses an oversized package envelope", async () => {
    const tree = await fixture();
    await writeFile(tree.packageFile, `${JSON.stringify(tree.envelope)}${" ".repeat(OVERSIZED_PACKAGE_BYTES)}`, "utf8");
    assertPublishVerifyFailure(runPublishVerify(tree), /large|size|limit|bounded/i);
  });

  it("refuses an oversized otherwise-valid index", async () => {
    const tree = await fixture();
    const index = path.join(tree.directory, "index.json");
    await writeFile(index, `${JSON.stringify(tree.index)}${" ".repeat(OVERSIZED_INDEX_BYTES)}`, "utf8");
    assertPublishVerifyFailure(runPublishVerify(tree), /large|size|limit|bounded/i);
  });

  it("refuses an oversized otherwise-valid key file", async () => {
    const tree = await fixture();
    await writeFile(tree.keyFile, `${TAP_KEY.publicKey}\n${" ".repeat(OVERSIZED_KEY_BYTES)}`, "utf8");
    assertPublishVerifyFailure(runPublishVerify(tree), /large|size|limit|bounded/i);
  });

  it("refuses non-canonical base64 and trailing DER bytes in the tap key", async () => {
    const malformed = await fixture();
    await writeFile(malformed.keyFile, ` ${TAP_KEY.publicKey}\n`, "utf8");
    assertPublishVerifyFailure(runPublishVerify(malformed), /base64|key.*malformed|canonical/i);

    const trailing = await fixture();
    const extended = Buffer.concat([Buffer.from(TAP_KEY.publicKey, "base64"), Buffer.from([0])]).toString("base64");
    await writeFile(trailing.keyFile, extended, "utf8");
    assertPublishVerifyFailure(runPublishVerify(trailing), /SPKI|Ed25519|key.*malformed/i);
  });

  it("refuses malformed UTF-8 before parsing signed protocol inputs", async () => {
    const packageTree = await fixture();
    await replaceMarkerWithMalformedUtf8(
      packageTree.packageFile,
      packageTree.envelope.publisherSignature.value,
    );
    assertPublishVerifyFailure(runPublishVerify(packageTree), /utf-?8|encoding|invalid byte/i);

    const indexTree = await fixture();
    await replaceMarkerWithMalformedUtf8(
      path.join(indexTree.directory, "index.json"),
      indexTree.index.signature.value,
    );
    assertPublishVerifyFailure(runPublishVerify(indexTree), /utf-?8|encoding|invalid byte/i);
  });

  it("refuses publisher and tap-key rotations as unverifiable snapshot continuity", async () => {
    const publisherTree = await fixture();
    await writeSignedDistributionIndex(publisherTree, { rotations: [signedRotation()] });
    assertPublishVerifyFailure(runPublishVerify(publisherTree), /continuity|rotation.*snapshot|snapshot.*rotation/i);
    const tapTree = await fixture();
    await writeSignedDistributionIndex(tapTree, { tapKeyRotation: signedTapRotation() });
    assertPublishVerifyFailure(runPublishVerify(tapTree), /continuity|rotation.*snapshot|snapshot.*rotation/i);
  });
});

async function replaceMarkerWithMalformedUtf8(file: string, marker: string): Promise<void> {
  const source = await readFile(file);
  const needle = Buffer.from(marker, "utf8");
  const offset = source.lastIndexOf(needle);
  if (offset < 0) throw new Error("fixture marker missing");
  await writeFile(file, Buffer.concat([
    source.subarray(0, offset),
    Buffer.from([0xc3, 0x28]),
    source.subarray(offset + needle.length),
  ]));
}
