/**
 * @file test/template-publish-verify-r9-leaf-binding.test.ts
 * @description Regression coverage binding the final publisher-verification
 * result to the authenticated bytes of every selected leaf class. Each case
 * rewrites an existing pathname without replacing its filesystem identity at
 * the final-result seam and requires the shared byte-selection guard to refuse.
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPublisherDistribution } from "../src/profile/templates/publish/verify.js";
import { TAP_KEY } from "./fixtures/template-signing.js";
import {
  createPublishDistribution,
  removePublishDistribution,
  type PublishDistribution,
} from "./fixtures/template-publish-distribution.js";

interface LeafRewriteCase {
  label: string;
  selectedPath: (tree: PublishDistribution) => string;
  refusal: RegExp;
}

interface FileIdentity {
  device: number;
  inode: number;
}

const fixtures: PublishDistribution[] = [];
const leafRewriteCases: LeafRewriteCase[] = [
  {
    label: "index",
    selectedPath: (tree) => path.join(tree.directory, "index.json"),
    refusal: /index content changed after its bytes were verified/i,
  },
  {
    label: "package",
    selectedPath: (tree) => tree.packageFile,
    refusal: /package content changed after its bytes were verified/i,
  },
  {
    label: "tap key",
    selectedPath: (tree) => tree.keyFile,
    refusal: /tap key content changed after its bytes were verified/i,
  },
];

afterEach(async () => Promise.all(fixtures.splice(0).map(removePublishDistribution)));

describe("template publish verify R9 final leaf binding", () => {
  it.each(leafRewriteCases)(
    "refuses an ordinary same-path write to the selected $label at the final-result seam",
    async ({ selectedPath, refusal }) => {
      const tree = await createPublishDistribution();
      fixtures.push(tree);
      const file = selectedPath(tree);
      const original = await readFile(file, "utf8");
      const identity = await fileIdentity(file);

      await expect(verifyPublisherDistribution(
        tree.directory,
        "official",
        TAP_KEY.keyId,
        tree.keyFile,
        { beforeFinalVerdictForTest: () => rewriteSelectedLeaf(file, original, identity) },
      )).rejects.toThrow(refusal);
    },
  );

  it.each(leafRewriteCases)(
    "refuses a BOM-prefixed same-inode rewrite of the selected $label",
    async ({ selectedPath, refusal }) => {
      const tree = await createPublishDistribution();
      fixtures.push(tree);
      const file = selectedPath(tree);
      const original = await readFile(file);
      const identity = await fileIdentity(file);

      await expect(verifyPublisherDistribution(
        tree.directory,
        "official",
        TAP_KEY.keyId,
        tree.keyFile,
        { beforeFinalVerdictForTest: () => prefixBom(file, original, identity) },
      )).rejects.toThrow(refusal);
    },
  );
});

/** Rewrite selected bytes through the same pathname while retaining its inode. */
async function rewriteSelectedLeaf(
  file: string,
  original: string,
  identity: FileIdentity,
): Promise<void> {
  await writeFile(file, `${original}\n`, "utf8");
  expect(await fileIdentity(file)).toEqual(identity);
}

/** Prefix a BOM through the selected pathname without replacing its inode. */
async function prefixBom(file: string, original: Buffer, identity: FileIdentity): Promise<void> {
  await writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]));
  expect(await fileIdentity(file)).toEqual(identity);
}

/** Read the stable filesystem identity used to prove this was not a replacement. */
async function fileIdentity(file: string): Promise<FileIdentity> {
  const selected = await stat(file);
  return { device: selected.dev, inode: selected.ino };
}
