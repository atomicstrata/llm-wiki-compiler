/**
 * @file src/products/paths.ts
 * @description Pure lexical construction for every product-package store root and
 * leaf (design section 7.6). Every content-addressed directory or file component
 * is validated through the shared 64-hex or random-token grammar before it joins
 * a path; this module performs no filesystem reads, directory creation, or
 * realpath resolution. It is the first of two path-enforcement layers: the second
 * is the no-follow realpath re-confinement performed immediately before I/O.
 */

import path from "node:path";
import { assertDigestHex } from "./ids.js";
import { ProductIdentityError } from "./problems.js";

/** The reserved store segment beneath one project's `.llmwiki` directory. */
const PRODUCT_PACKAGES_SEGMENT = "product-packages";
/** The reserved content-addressed algorithm segment. */
const SHA256_SEGMENT = "sha256";
/** The reserved project-private staging segment for in-progress installs. */
const TMP_SEGMENT = "tmp";
/**
 * The reserved advisory-receipt root beneath `.llmwiki`, a SIBLING of the package
 * store (section 7.6) — never a child of `product-packages/`, so a receipt is not
 * counted against the package-store capacity ceiling nor mistaken for package bytes.
 */
const PRODUCT_PACKAGE_RECEIPTS_SEGMENT = "product-package-receipts";
/** The reserved member-bytes segment beneath one package directory. */
export const MEMBERS_SEGMENT = "members";
/** The reserved canonical manifest filename beneath one package directory. */
export const MANIFEST_FILENAME = "manifest.json";

const TEMP_TOKEN = /^[0-9a-f]{32}$/;

/** Validate one project-private staging-directory token. */
function assertTempToken(value: unknown): string {
  if (typeof value !== "string" || !TEMP_TOKEN.test(value)) {
    throw new ProductIdentityError("package-directory");
  }
  return value;
}

/** Fixed roots and validated leaf constructors for one project's package store. */
export interface ProductStorePaths {
  storeRoot: string;
  sha256Root: string;
  tmpRoot: string;
  receiptsRoot: string;
  packageDir(digestHex: string): string;
  manifestFile(digestHex: string): string;
  membersRoot(digestHex: string): string;
  memberFile(digestHex: string, memberHex: string): string;
  receiptFile(digestHex: string): string;
  tmpPackageDir(token: string): string;
  tmpManifestFile(token: string): string;
  tmpMembersRoot(token: string): string;
  tmpMemberFile(token: string, memberHex: string): string;
}

/** Build the installed-package leaf constructors beneath the sha256 root. */
function installedLeaves(sha256Root: string) {
  const packageDir = (digestHex: string) => path.join(sha256Root, assertDigestHex(digestHex));
  const membersRoot = (digestHex: string) => path.join(packageDir(digestHex), MEMBERS_SEGMENT);
  return {
    packageDir,
    membersRoot,
    manifestFile: (digestHex: string) => path.join(packageDir(digestHex), MANIFEST_FILENAME),
    memberFile: (digestHex: string, memberHex: string) =>
      path.join(membersRoot(digestHex), assertDigestHex(memberHex)),
  };
}

/** Build the project-private staging leaf constructors beneath the tmp root. */
function stagingLeaves(tmpRoot: string) {
  const tmpPackageDir = (token: string) => path.join(tmpRoot, assertTempToken(token));
  const tmpMembersRoot = (token: string) => path.join(tmpPackageDir(token), MEMBERS_SEGMENT);
  return {
    tmpPackageDir,
    tmpMembersRoot,
    tmpManifestFile: (token: string) => path.join(tmpPackageDir(token), MANIFEST_FILENAME),
    tmpMemberFile: (token: string, memberHex: string) =>
      path.join(tmpMembersRoot(token), assertDigestHex(memberHex)),
  };
}

/** Return the complete lexical product-package store layout for one project. */
export function productStorePaths(root: string): ProductStorePaths {
  const storeRoot = path.join(root, ".llmwiki", PRODUCT_PACKAGES_SEGMENT);
  const sha256Root = path.join(storeRoot, SHA256_SEGMENT);
  const tmpRoot = path.join(storeRoot, TMP_SEGMENT);
  const receiptsRoot = path.join(root, ".llmwiki", PRODUCT_PACKAGE_RECEIPTS_SEGMENT);
  return {
    storeRoot,
    sha256Root,
    tmpRoot,
    receiptsRoot,
    receiptFile: (digestHex: string) => path.join(receiptsRoot, `${assertDigestHex(digestHex)}.json`),
    ...installedLeaves(sha256Root),
    ...stagingLeaves(tmpRoot),
  };
}
