/**
 * @file src/products/packages/install.ts
 * @description The INERT local product-package install (design section 7.6). It
 * copies an operator-supplied package into a fresh owner-private staging tree
 * through no-follow reads, parses and verifies every member, graph, digest, and
 * bound from that private snapshot, then acquires the project lock and recovery
 * gate, re-verifies the snapshot under the lock, and hands the verified bytes to
 * the immutable store which enforces capacity and atomically renames them into
 * place. It writes an advisory `local-unverified` receipt and reports installed
 * only after an offline read resolves the same package. It performs NO
 * activation and NEVER writes `active-product.json`: a receipt failure leaves
 * inert bytes with provenance unavailable, never an active binding.
 *
 * Only the PROJECT commit leg is a body over project steps:
 * {@link commitInstalledPackageWith} over {@link ProductInstallCommitSteps}. The
 * operator-supplied intake and the owner-private `os.tmpdir()` staging are the
 * local host's and stay as they are.
 */

import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { canonicalBytes } from "../../profile/templates/signing/canonical.js";
import { removeTreeForced } from "../../storage/disk-bundle-tree.js";
import {
  makeDirectoryTreeWithMode, makeUniqueDirectory, readCappedBytesClassified, writeLocationBytesWithMode,
} from "../../storage/disk-durable-leaves.js";
import { locationKindNoFollow } from "../../storage/disk-local-reads.js";
import { acquireMutationLockBlocking } from "../../operation-bundles/lock-gate.js";
import { releaseLock } from "../../utils/lock.js";
import { MAX_KNOWLEDGE_PROFILE_BYTES, MAX_PRODUCT_MANIFEST_BYTES } from "../constants.js";
import { digestDirectoryName, type Sha256Digest } from "../ids.js";
import { ProductPackageError } from "../problems.js";
import { MANIFEST_FILENAME, MEMBERS_SEGMENT } from "../paths.js";
import type { ProductInstallProvenance, ProductInstallReceiptV1, ProductPackageManifestV1 } from "../types.js";
import {
  commitProductPackage, readInstalledProductPackage, type ProductPackageCommitResult,
} from "./store.js";
import { buildProductInstallReceipt, writeProductInstallReceipt } from "./receipts.js";
import { loadProductPackageManifest, verifyProductPackageMemberBytes } from "./verify.js";

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const STAGING_PREFIX = "llmwiki-product-";
const OWNER_PRIVATE_DIR = 0o700;
const OWNER_PRIVATE_FILE = 0o600;

/** A verified package snapshot loaded from the owner-private staging tree. */
interface StagedPackage {
  manifest: ProductPackageManifestV1;
  bytesByHex: Map<string, Buffer>;
}

/** The settled outcome of one inert local install. */
export interface ProductInstallResultV1 {
  status: "installed" | "already-present";
  productId: string;
  productVersion: string;
  packageDigest: Sha256Digest;
  provenance: ProductInstallProvenance;
  receiptWritten: boolean;
}

/** Require a real, non-symlinked source directory before any leaf is read. */
async function assertRealDirectory(dir: string): Promise<void> {
  const kind = await locationKindNoFollow(dir).catch(() => null);
  if (kind !== "directory") throw new ProductPackageError("source path is not a real directory");
}

/** Read one source or staged leaf no-follow, or fail closed on any refusal. */
async function readLeaf(file: string, maxBytes: number): Promise<Buffer> {
  const read = await readCappedBytesClassified(file, maxBytes);
  if (read.kind !== "ok") throw new ProductPackageError(`package leaf is ${read.kind}`);
  return read.body;
}

/** Write one owner-private staging leaf. */
async function writeStagedLeaf(file: string, bytes: Buffer): Promise<void> {
  await writeLocationBytesWithMode(file, bytes, OWNER_PRIVATE_FILE);
}

/** Copy the operator-supplied package into the owner-private staging tree. */
async function ingestToStaging(sourceDir: string, staging: string): Promise<void> {
  await assertRealDirectory(sourceDir);
  const manifestBytes = await readLeaf(path.join(sourceDir, MANIFEST_FILENAME), MAX_PRODUCT_MANIFEST_BYTES);
  const manifest = loadProductPackageManifest(STRICT_UTF8.decode(manifestBytes));
  await writeStagedLeaf(path.join(staging, MANIFEST_FILENAME), manifestBytes);
  const sourceMembers = path.join(sourceDir, MEMBERS_SEGMENT);
  await assertRealDirectory(sourceMembers);
  await makeDirectoryTreeWithMode(path.join(staging, MEMBERS_SEGMENT), OWNER_PRIVATE_DIR);
  for (const member of manifest.members) {
    const hex = digestDirectoryName(member.digest);
    const bytes = await readLeaf(path.join(sourceMembers, hex), MAX_KNOWLEDGE_PROFILE_BYTES);
    await writeStagedLeaf(path.join(staging, MEMBERS_SEGMENT, hex), bytes);
  }
}

/** Load and fully verify the package snapshot from the private staging tree. */
async function loadStagedPackage(staging: string): Promise<StagedPackage> {
  const manifestBytes = await readLeaf(path.join(staging, MANIFEST_FILENAME), MAX_PRODUCT_MANIFEST_BYTES);
  const manifest = loadProductPackageManifest(STRICT_UTF8.decode(manifestBytes));
  if (!canonicalBytes(manifest).equals(manifestBytes)) throw new ProductPackageError("staged manifest is not canonical");
  const bytesByHex = new Map<string, Buffer>();
  for (const member of manifest.members) {
    const hex = digestDirectoryName(member.digest);
    bytesByHex.set(hex, await readLeaf(path.join(staging, MEMBERS_SEGMENT, hex), MAX_KNOWLEDGE_PROFILE_BYTES));
  }
  verifyProductPackageMemberBytes(manifest, bytesByHex);
  return { manifest, bytesByHex };
}

/** What the install's PROJECT commit leg asks of the project. No member takes a project root. */
export interface ProductInstallCommitSteps {
  /** Commit the verified package into the immutable store (the caller holds the lock). */
  commit(manifest: ProductPackageManifestV1, bytesByHex: ReadonlyMap<string, Buffer>): Promise<ProductPackageCommitResult>;
  /** The installed package at a digest, read offline. */
  readInstalled(packageDigest: Sha256Digest): ReturnType<typeof readInstalledProductPackage>;
  /** Durably write the advisory receipt. */
  writeReceipt(receipt: ProductInstallReceiptV1): Promise<void>;
}

/** LOCAL DISK: the incumbent commit, offline read and receipt write for one root, built per call. In no package index. */
export function localProductInstallCommitSteps(root: string): ProductInstallCommitSteps {
  return {
    commit: (manifest, bytesByHex) => commitProductPackage(root, manifest, bytesByHex),
    readInstalled: (packageDigest) => readInstalledProductPackage(root, packageDigest),
    writeReceipt: (receipt) => writeProductInstallReceipt(root, receipt),
  };
}

/** Write the advisory receipt, degrading to provenance-unavailable on failure. */
async function tryWriteReceipt(steps: ProductInstallCommitSteps, manifest: ProductPackageManifestV1): Promise<boolean> {
  try {
    await steps.writeReceipt(buildProductInstallReceipt(manifest, "local-unverified"));
    return true;
  } catch {
    return false;
  }
}

/**
 * The install's PROJECT commit leg: THE ONE BODY. Commit, then require an offline
 * read to resolve the package (a convergence already is one), then the advisory receipt, whose failure leaves the
 * package inert with provenance unavailable. Never activates. The caller holds the lock.
 */
export async function commitInstalledPackageWith(
  steps: ProductInstallCommitSteps, staged: { manifest: ProductPackageManifestV1; bytesByHex: ReadonlyMap<string, Buffer> },
): Promise<ProductInstallResultV1> {
  const commit = await steps.commit(staged.manifest, staged.bytesByHex);
  // A commit converges ONLY onto a package its own offline read has just
  // resolved as `ok` (and renames nothing after it), so that read is this
  // proof; a fresh rename is proven by a new read at its final place.
  const resolves = commit.status === "converged"
    || (await steps.readInstalled(staged.manifest.packageDigest)).status === "ok";
  if (!resolves) {
    throw new ProductPackageError("installed package did not resolve on an offline read");
  }
  return buildResult(staged.manifest, commit, await tryWriteReceipt(steps, staged.manifest));
}

/** Assemble the settled install result from the commit outcome and receipt state. */
function buildResult(
  manifest: ProductPackageManifestV1, commit: ProductPackageCommitResult, receiptWritten: boolean,
): ProductInstallResultV1 {
  return {
    status: commit.status === "committed" ? "installed" : "already-present",
    productId: manifest.productId,
    productVersion: manifest.productVersion,
    packageDigest: manifest.packageDigest,
    provenance: "local-unverified",
    receiptWritten,
  };
}

/** Re-verify the snapshot under the project lock, commit, and report installed. */
async function installStagedUnderLock(
  root: string, staging: string, preLock: StagedPackage,
): Promise<ProductInstallResultV1> {
  await acquireMutationLockBlocking(root, "ordinary");
  try {
    const staged = await loadStagedPackage(staging);
    if (staged.manifest.packageDigest !== preLock.manifest.packageDigest) {
      throw new ProductPackageError("staged package changed before installation");
    }
    return await commitInstalledPackageWith(localProductInstallCommitSteps(root), staged);
  } finally {
    await releaseLock(root);
  }
}

/**
 * Install one operator-supplied local product package inertly. The package
 * directory holds a canonical `manifest.json` and a `members/<digest>` file per
 * member. Installation stores bytes and writes an advisory receipt but performs
 * no activation and never writes `active-product.json`.
 */
export async function installLocalProductPackage(root: string, sourceDir: string): Promise<ProductInstallResultV1> {
  const staging = await makeUniqueDirectory(path.join(os.tmpdir(), STAGING_PREFIX));
  try {
    await ingestToStaging(sourceDir, staging);
    const preLock = await loadStagedPackage(staging);
    return await installStagedUnderLock(root, staging, preLock);
  } finally {
    await removeTreeForced(staging).catch(() => {});
  }
}
