/**
 * @file src/products/packages/receipts.ts
 * @description The advisory product-install receipt (design section 7.6). A
 * receipt records provenance and package identity but confers NO activation
 * authority and never names `active-product.json`; a missing, unreadable, or
 * invalid receipt leaves inert package bytes with provenance unavailable rather
 * than an active binding. Slice 1 writes only `local-unverified` provenance.
 * Receipts live beside — never inside — the immutable package bytes so a receipt
 * repair can rewrite one without mutating a content-addressed package.
 */

import { canonicalBytes } from "../../profile/templates/signing/canonical.js";
import { parseBoundedUniqueJson } from "../../profile/templates/signing/json.js";
import { enumValue, exact, record, timestamp } from "../../operation-bundles/manifest-values.js";
import { atomicWrite } from "../../utils/atomic-write.js";
import { readConfinedLeaf } from "../../utils/confined-read.js";
import { MAX_PRODUCT_INSTALL_RECEIPT_BYTES, PRODUCT_INSTALL_RECEIPT_SCHEMA_VERSION } from "../constants.js";
import { assertProductDigest, assertProductId, assertVersion, digestDirectoryName } from "../ids.js";
import { asProductProblem, ProductPackageError } from "../problems.js";
import { productStorePaths } from "../paths.js";
import type { ProductInstallProvenance, ProductInstallReceiptV1, ProductPackageManifestV1 } from "../types.js";

const RECEIPT_KEYS = [
  "schemaVersion", "productId", "productVersion", "packageDigest", "runtimeAuthorityDigest",
  "provenance", "installedAt",
] as const;
const PROVENANCES: readonly ProductInstallProvenance[] = ["builtin", "remote-verified", "local-unverified"];

/** Complete read classification for one advisory install receipt. */
export type ProductInstallReceiptRead =
  | { status: "ok"; receipt: ProductInstallReceiptV1 }
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "unavailable" };

/** Build one advisory receipt from a verified manifest and its provenance. */
export function buildProductInstallReceipt(
  manifest: ProductPackageManifestV1, provenance: ProductInstallProvenance = "local-unverified",
): ProductInstallReceiptV1 {
  return {
    schemaVersion: PRODUCT_INSTALL_RECEIPT_SCHEMA_VERSION,
    productId: manifest.productId,
    productVersion: manifest.productVersion,
    packageDigest: manifest.packageDigest,
    runtimeAuthorityDigest: manifest.runtimeAuthorityDigest,
    provenance,
    installedAt: new Date().toISOString(),
  };
}

/** Rebuild and validate one advisory receipt from its canonical bytes. */
function parseProductInstallReceipt(text: string): ProductInstallReceiptV1 {
  return asProductProblem(() => {
    const root = record(parseBoundedUniqueJson(text, MAX_PRODUCT_INSTALL_RECEIPT_BYTES), "install receipt");
    exact(root, RECEIPT_KEYS);
    if (root.schemaVersion !== PRODUCT_INSTALL_RECEIPT_SCHEMA_VERSION) {
      throw new ProductPackageError("install receipt schemaVersion must be 1");
    }
    return {
      schemaVersion: PRODUCT_INSTALL_RECEIPT_SCHEMA_VERSION,
      productId: assertProductId(root.productId),
      productVersion: assertVersion(root.productVersion),
      packageDigest: assertProductDigest(root.packageDigest),
      runtimeAuthorityDigest: assertProductDigest(root.runtimeAuthorityDigest),
      provenance: enumValue(root.provenance, PROVENANCES, "provenance"),
      installedAt: timestamp(root.installedAt),
    };
  });
}

/** Durably write one advisory receipt; callers must not treat it as authority. */
export async function writeProductInstallReceipt(root: string, receipt: ProductInstallReceiptV1): Promise<void> {
  const bytes = canonicalBytes(receipt);
  if (bytes.byteLength > MAX_PRODUCT_INSTALL_RECEIPT_BYTES) {
    throw new ProductPackageError("advisory install receipt exceeds its byte cap");
  }
  const file = productStorePaths(root).receiptFile(digestDirectoryName(receipt.packageDigest));
  await atomicWrite(file, bytes, { confineRoot: root, durable: true });
}

/** Read one advisory receipt through the confined no-follow leaf reader. */
export async function readProductInstallReceipt(
  root: string, packageDigest: ProductPackageManifestV1["packageDigest"],
): Promise<ProductInstallReceiptRead> {
  const paths = productStorePaths(root);
  const read = await readConfinedLeaf(
    root, paths.receiptFile(digestDirectoryName(packageDigest)), paths.receiptsRoot,
    MAX_PRODUCT_INSTALL_RECEIPT_BYTES);
  if (read.kind === "absent") return { status: "absent" };
  if (read.kind !== "ok") return { status: "unavailable" };
  try {
    return { status: "ok", receipt: parseProductInstallReceipt(read.body) };
  } catch {
    return { status: "invalid" };
  }
}
