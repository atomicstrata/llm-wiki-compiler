/**
 * @file src/products/binding/manifest-authority.ts
 * @description Shared, single-source-of-truth derivation of a binding's runtime
 * component digests from a verified product manifest, plus confined reads of the
 * installed package's members (design sections 8.1, 8.3). Both the resolver and
 * the activator derive expected component digests HERE, so a binding is correct by
 * construction and the resolver's fail-closed check compares against the same
 * derivation the activator wrote — two agreeing controls by construction, not by
 * inspection.
 *
 * ACYCLIC RULE: this module (and every `products/binding` module) loads the
 * knowledge-profile member and validates it through `validatedProfileText`
 * (`validateProfile` + `profileDigest`) DIRECTLY. It MUST NOT call
 * `loadProfile()` — the profile loader imports the binding, never the reverse,
 * so the effective-profile dependency stays a DAG.
 */

import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { validatedProfileText } from "../../profile/validated-text.js";
import type { LoadedProfile } from "../../profile/types.js";
import { digestDirectoryName, type Sha256Digest } from "../ids.js";
import { diskProductPackageReads, type ProductPackageReads, type VerifiedMemberBytes } from "../packages/store.js";
import { productStorePaths } from "../paths.js";
import type { PackageMemberRefV1, ProductPackageManifestV1 } from "../types.js";
import { ProductBindingError } from "./problems.js";
import type { ActiveProductBindingV1 } from "./types.js";

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** The manifest-derived fields a binding repeats; identity plus runtime digests. */
export interface BindingManifestComponents {
  productId: string;
  productVersion: string;
  packageDigest: Sha256Digest;
  runtimeAuthorityDigest: Sha256Digest;
  productManifestDigest: Sha256Digest;
  knowledgeProfileDigest: Sha256Digest;
  operationsPackDigest: Sha256Digest;
  compositionLockDigest: Sha256Digest;
  processDefinitionDigest?: Sha256Digest;
  parityLedgerDigest: Sha256Digest;
}

/**
 * Derive the exact component digests a binding must repeat (design section 8.1).
 * `productManifestDigest` is the canonical digest of the WHOLE manifest document;
 * every other digest is copied from the manifest's own fields or member table.
 */
export function deriveBindingComponents(manifest: ProductPackageManifestV1): BindingManifestComponents {
  const components: BindingManifestComponents = {
    productId: manifest.productId,
    productVersion: manifest.productVersion,
    packageDigest: manifest.packageDigest,
    runtimeAuthorityDigest: manifest.runtimeAuthorityDigest,
    productManifestDigest: canonicalDigest(manifest) as Sha256Digest,
    knowledgeProfileDigest: manifest.knowledgeProfile.digest,
    operationsPackDigest: manifest.rootOperationsPack.digest,
    compositionLockDigest: manifest.compositionLock.digest,
    parityLedgerDigest: manifest.parityLedger.digest,
  };
  return manifest.processDefinition === undefined
    ? components
    : { ...components, processDefinitionDigest: manifest.processDefinition.digest };
}

/**
 * Return the first component-digest field on which a binding disagrees with the
 * manifest, or `null` when every derived field matches exactly. Fail-closed
 * diagnostics: the mismatched field NAME is safe to surface (never a caller value).
 */
export function bindingComponentMismatch(
  binding: ActiveProductBindingV1, manifest: ProductPackageManifestV1,
): keyof BindingManifestComponents | null {
  const expected = deriveBindingComponents(manifest);
  for (const key of Object.keys(expected) as (keyof BindingManifestComponents)[]) {
    if (binding[key] !== expected[key]) return key;
  }
  if (binding.processDefinitionDigest !== expected.processDefinitionDigest) {
    return "processDefinitionDigest";
  }
  return null;
}

/**
 * Read one installed member leaf from the immutable store through the hardened
 * confined, no-follow, single-link reader and re-verify its content digest and
 * byte count against the member reference. Any missing, symlinked, swapped, or
 * oversize leaf fails closed as a {@link ProductBindingError}.
 */
async function readStoredMemberBuffer(
  reads: ProductPackageReads, packageDigest: Sha256Digest, member: PackageMemberRefV1, maxBytes: number,
): Promise<Buffer> {
  const pkgHex = digestDirectoryName(packageDigest);
  const memberHex = digestDirectoryName(member.digest);
  const read = await reads.readMemberLeaf(pkgHex, memberHex, maxBytes);
  if (read.kind !== "ok") throw new ProductBindingError(`${member.kind} member is ${read.kind}`);
  if (read.body.byteLength !== member.byteCount) throw new ProductBindingError(`${member.kind} member byte count disagrees`);
  if (createHash("sha256").update(read.body).digest("hex") !== memberHex) {
    throw new ProductBindingError(`${member.kind} member bytes disagree with its digest`);
  }
  return read.body;
}

/** Read one installed member leaf and strictly decode it as UTF-8 text. */
export async function readStoredMemberText(
  root: string, packageDigest: Sha256Digest, member: PackageMemberRefV1, maxBytes: number,
): Promise<string> {
  // `async` so that a throw while the disk sources are built REJECTS, as this function always did.
  return readStoredMemberTextFrom(diskProductPackageReads(root), packageDigest, member, maxBytes);
}

/** {@link readStoredMemberText} over the package reads: THE ONE BODY. The cap is the caller's; the byte-count, digest and strict-UTF-8 checks are made here. */
export async function readStoredMemberTextFrom(
  reads: ProductPackageReads, packageDigest: Sha256Digest, member: PackageMemberRefV1, maxBytes: number,
): Promise<string> {
  return STRICT_UTF8.decode(await readStoredMemberBuffer(reads, packageDigest, member, maxBytes));
}

/**
 * One member's text from the bytes the installed-package read already verified,
 * or `null` when that read did not keep them, or when they would not pass the
 * capped read: larger than `maxBytes`, or a length other than the reference's
 * `byteCount`. On `null` the caller makes the capped read, which classifies
 * that case exactly as before. Held bytes were digest-checked against
 * `member.digest` (their key) by the same check the stored read repeats, and
 * are decoded by the same strict UTF-8 decoder, so a non-null answer is what
 * {@link readStoredMemberTextFrom} would have returned for them.
 */
export function verifiedMemberText(held: VerifiedMemberBytes, member: PackageMemberRefV1, maxBytes: number): string | null {
  const bytes = held.get(digestDirectoryName(member.digest));
  if (bytes === undefined || bytes.byteLength > maxBytes || bytes.byteLength !== member.byteCount) return null;
  return STRICT_UTF8.decode(bytes);
}

/** The absolute member-file path used as a product-mode profile's `loadedFrom`. */
export function knowledgeProfileMemberPath(root: string, packageDigest: Sha256Digest, memberDigest: Sha256Digest): string {
  const paths = productStorePaths(root);
  return paths.memberFile(digestDirectoryName(packageDigest), digestDirectoryName(memberDigest));
}

/**
 * Load and validate the knowledge-profile member into a {@link LoadedProfile},
 * validating it through {@link validatedProfileText} DIRECTLY (never
 * `loadProfile`). `loadedFrom` is the member's absolute store path so the product
 * profile is treated as non-default by every read surface. A parse or validation
 * failure throws; the caller classifies it as `unavailable`.
 */
export function loadKnowledgeProfileMember(text: string, memberPath: string): LoadedProfile {
  const { profile, digest } = validatedProfileText(text,
    (parseError) => new ProductBindingError("knowledge-profile member is not valid JSON", { cause: parseError }));
  return { profile, loadedFrom: memberPath, digest };
}
