/**
 * @file test/template-publish-verify-cli.test.ts
 * @description Frozen Slice A CLI acceptance oracle for successful output,
 * cryptographic failures, validation reuse, privacy, and help separation.
 */
import { spawnSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProfileTemplatePackage } from "../src/profile/templates/types.js";
import {
  COORDINATE,
  PUBLISHER_KEY,
  signedPackage,
  TAP_KEY,
} from "./fixtures/template-signing.js";
import {
  CLI_TIMEOUT_MS,
  assertPublishVerifyFailure,
  createPublishDistribution,
  removePublishDistribution,
  runPublishVerify,
  snapshotTree,
  writeSignedDistributionIndex,
  type PublishDistribution,
} from "./fixtures/template-publish-distribution.js";

const CLI = path.resolve("dist/cli.js");
const fixtures: PublishDistribution[] = [];
const HUMAN_SUCCESS_OUTPUT = [
  "Verified template publisher distribution.",
  "Scope: snapshot",
  "Continuity: not_applicable_no_rotations",
  "Tap: official",
  "Sequence: 1",
  `Tap key: ${TAP_KEY.keyId}`,
  "Packages: 1",
  "",
].join("\n");

async function fixture(envelope = signedPackage()): Promise<PublishDistribution> {
  const value = await createPublishDistribution(envelope);
  fixtures.push(value);
  return value;
}

afterEach(async () => Promise.all(fixtures.splice(0).map(removePublishDistribution)));

describe("template publish verify CLI", () => {
  it("verifies a valid static tree in stable human and JSON modes without writes", async () => {
    const tree = await fixture();
    const before = await snapshotTree(tree.root);
    const human = runPublishVerify(tree);
    const json = runPublishVerify(tree, ["--json"]);
    expect(human.status).toBe(0);
    expect(human.stdout).toBe(HUMAN_SUCCESS_OUTPUT);
    expect(human.stderr).toBe("");
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(successEnvelope());
    expect(await snapshotTree(tree.root)).toEqual(before);
  });

  it("keeps JSON output free of secrets, payloads, paths, and terminal controls", async () => {
    const tree = await fixture();
    const result = runPublishVerify(tree, ["--json"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(TAP_KEY.publicKey);
    expect(result.stdout).not.toContain(tree.root);
    expect(result.stdout).not.toContain(tree.envelope.publisherSignature.value);
    expect(result.stdout).not.toContain(tree.envelope.payload.displayName);
    expect(result.stdout).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
  });

  it("fails closed for a wrong tap key and a wrong key id", async () => {
    const tree = await fixture();
    const wrongKeyFile = path.join(tree.root, "wrong-key.txt");
    await writeFile(wrongKeyFile, PUBLISHER_KEY.publicKey, "utf8");
    assertPublishVerifyFailure(runPublishVerify(tree, [], TAP_KEY.keyId, wrongKeyFile), /signature|tap key/i);
    assertPublishVerifyFailure(runPublishVerify(tree, [], "wrong-key-id"), /key id|trusted key|wrong key/i);
  });

  it("does not emit a JSON success object after verification fails", async () => {
    const tree = await fixture();
    assertPublishVerifyFailure(runPublishVerify(tree, ["--json"], "wrong-key-id"), /key id|trusted key|wrong key/i);
  });

  it("fails closed for expired and future indexes", async () => {
    const tree = await fixture();
    await writeSignedDistributionIndex(tree, {
      generatedAt: "2020-01-01T00:00:00Z",
      expiresAt: "2020-01-02T00:00:00Z",
    });
    assertPublishVerifyFailure(runPublishVerify(tree), /expired/i);
    await writeSignedDistributionIndex(tree, {
      generatedAt: "2099-01-01T00:00:00Z",
      expiresAt: "2099-01-02T00:00:00Z",
    });
    assertPublishVerifyFailure(runPublishVerify(tree), /future|not yet valid/i);
  });

  it("fails closed for altered index and package bytes", async () => {
    const tree = await fixture();
    const indexPath = path.join(tree.directory, "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.sequence += 1;
    await writeFile(indexPath, JSON.stringify(index), "utf8");
    assertPublishVerifyFailure(runPublishVerify(tree), /signature/i);
    await writeFile(indexPath, JSON.stringify(tree.index), "utf8");
    const envelope = JSON.parse(await readFile(tree.packageFile, "utf8"));
    envelope.payload.displayName = "Altered";
    await writeFile(tree.packageFile, JSON.stringify(envelope), "utf8");
    assertPublishVerifyFailure(runPublishVerify(tree), /digest|signature/i);
  });

  it("independently verifies the publisher signature and coordinate identity", async () => {
    const envelope = signedPackage();
    envelope.publisherSignature.value = corruptBase64(envelope.publisherSignature.value);
    const signatureTree = await fixture(envelope);
    assertPublishVerifyFailure(runPublishVerify(signatureTree), /signature/i);
    const conflictingCoordinate = COORDINATE.replace("/team@", "/other@");
    const identityTree = await fixture(signedPackage(signedPackage().payload, conflictingCoordinate));
    assertPublishVerifyFailure(runPublishVerify(identityTree), /coordinate|identity|template.*match/i);
  });

  it("reuses strict production parsing for package envelopes and signed digest fields", async () => {
    const unexpectedTree = await fixture();
    const serialized = await readFile(unexpectedTree.packageFile, "utf8");
    await writeFile(unexpectedTree.packageFile, serialized.replace("{", '{"unexpected":true,'), "utf8");
    assertPublishVerifyFailure(runPublishVerify(unexpectedTree), /unexpected|unknown|key|field/i);

    const duplicateTree = await fixture();
    const duplicateSource = await readFile(duplicateTree.packageFile, "utf8");
    await writeFile(
      duplicateTree.packageFile,
      duplicateSource.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      "utf8",
    );
    assertPublishVerifyFailure(runPublishVerify(duplicateTree), /duplicate.*key|key.*duplicate/i);

    const duplicateIndexTree = await fixture();
    const indexPath = path.join(duplicateIndexTree.directory, "index.json");
    const indexSource = await readFile(indexPath, "utf8");
    await writeFile(
      indexPath,
      indexSource.replace('"sequence":1', '"sequence":1,"sequence":1'),
      "utf8",
    );
    assertPublishVerifyFailure(runPublishVerify(duplicateIndexTree), /duplicate.*key|key.*duplicate/i);

    const digestTree = await fixture();
    await writeSignedDistributionIndex(digestTree, { packages: [{
      ...digestTree.index.packages[0],
      payloadDigest: "sha256:../../outside" as `sha256:${string}`,
    }] });
    assertPublishVerifyFailure(runPublishVerify(digestTree), /digest|sha256|invalid/i);
  });

  it("fails closed for a wrong package filename and invalid signed template", async () => {
    const tree = await fixture();
    const wrong = path.join(path.dirname(tree.packageFile), `${"a".repeat(64)}.json`);
    await rename(tree.packageFile, wrong);
    assertPublishVerifyFailure(runPublishVerify(tree), /missing|digest|filename/i);
    const invalid = { ...signedPackage().payload, displayName: "" } as ProfileTemplatePackage;
    const invalidTree = await fixture(signedPackage(invalid));
    assertPublishVerifyFailure(runPublishVerify(invalidTree), /displayName|template|invalid/i);
  });

  it("fails closed when a signed package digest or publisher key is revoked", async () => {
    const tree = await fixture();
    await writeSignedDistributionIndex(tree, { revocations: [{
      kind: "package",
      value: tree.envelope.payloadDigest,
      reason: "withdrawn",
      revokedAt: new Date().toISOString(),
    }] });
    assertPublishVerifyFailure(runPublishVerify(tree), /revoked/i);
    const keyTree = await fixture();
    await writeSignedDistributionIndex(keyTree, { revocations: [{
      kind: "publisher-key",
      value: PUBLISHER_KEY.keyId,
      reason: "compromised",
      revokedAt: new Date().toISOString(),
    }] });
    assertPublishVerifyFailure(runPublishVerify(keyTree), /revoked/i);
  });

  it("distinguishes consumer verification from publisher distribution verification in help", () => {
    const templateHelp = spawnSync(process.execPath, [CLI, "template", "--help"], {
      encoding: "utf8", timeout: CLI_TIMEOUT_MS,
    });
    const publishHelp = spawnSync(process.execPath, [CLI, "template", "publish", "--help"], {
      encoding: "utf8", timeout: CLI_TIMEOUT_MS,
    });
    expect(templateHelp.error).toBeUndefined();
    expect(templateHelp.signal).toBeNull();
    expect(publishHelp.error).toBeUndefined();
    expect(publishHelp.signal).toBeNull();
    expect(templateHelp.status).toBe(0);
    expect(templateHelp.stdout).toMatch(/verify <coordinate>.*remote template package/i);
    expect(templateHelp.stdout).toMatch(/publish.*publisher|publish.*distribution/i);
    expect(publishHelp.status).toBe(0);
    expect(publishHelp.stdout).toMatch(/verify <directory>.*offline|verify <directory>.*distribution/i);
  });
});

function successEnvelope() {
  return {
    schemaVersion: 1,
    verified: true,
    scope: "snapshot",
    continuity: "not_applicable_no_rotations",
    tap: "official",
    sequence: 1,
    tapKeyId: TAP_KEY.keyId,
    packageCount: 1,
  };
}

function corruptBase64(value: string): string {
  const replacement = value.startsWith("A") ? "B" : "A";
  return `${replacement}${value.slice(1)}`;
}
