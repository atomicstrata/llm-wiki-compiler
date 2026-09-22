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
 * knowledge-profile member and calls {@link validateProfile}/{@link profileDigest}
 * DIRECTLY. It MUST NOT call `loadProfile()` — the profile loader imports the
 * binding, never the reverse, so the effective-profile dependency stays a DAG.
 */

import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { readConfinedLeafBuffer } from "../../utils/confined-read.js";
import { profileDigest } from "../../profile/digest.js";
import { validateProfile } from "../../profile/validate.js";
import type { LoadedProfile } from "../../profile/types.js";
import { digestDirectoryName, type Sha256Digest } from "../ids.js";
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
  root: string, packageDigest: Sha256Digest, member: PackageMemberRefV1, maxBytes: number,
): Promise<Buffer> {
  const paths = productStorePaths(root);
  const pkgHex = digestDirectoryName(packageDigest);
  const memberHex = digestDirectoryName(member.digest);
  const read = await readConfinedLeafBuffer(
    root, paths.memberFile(pkgHex, memberHex), paths.membersRoot(pkgHex), maxBytes, { requireSingleLink: true });
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
  return STRICT_UTF8.decode(await readStoredMemberBuffer(root, packageDigest, member, maxBytes));
}

/** The absolute member-file path used as a product-mode profile's `loadedFrom`. */
export function knowledgeProfileMemberPath(root: string, packageDigest: Sha256Digest, memberDigest: Sha256Digest): string {
  const paths = productStorePaths(root);
  return paths.memberFile(digestDirectoryName(packageDigest), digestDirectoryName(memberDigest));
}

/**
 * Load and validate the knowledge-profile member into a {@link LoadedProfile},
 * calling {@link validateProfile}/{@link profileDigest} DIRECTLY (never
 * `loadProfile`). `loadedFrom` is the member's absolute store path so the product
 * profile is treated as non-default by every read surface. A parse or validation
 * failure throws; the caller classifies it as `unavailable`.
 */
export function loadKnowledgeProfileMember(text: string, memberPath: string): LoadedProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ProductBindingError("knowledge-profile member is not valid JSON", { cause: error });
  }
  const { profile } = validateProfile(parsed);
  return { profile, loadedFrom: memberPath, digest: profileDigest(profile) };
}
