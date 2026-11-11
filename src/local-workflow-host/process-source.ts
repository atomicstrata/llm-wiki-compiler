/**
 * @file src/local-workflow-host/process-source.ts
 * @description Read the active package's retained process-definition bytes with
 * existing binding, digest and size checks. Interpretation remains engine-owned.
 *
 * ONE BODY. {@link readLocalWorkflowProcessSource} keeps its signature and runs
 * {@link readLocalWorkflowProcessSourceFrom} over the incumbent root readers;
 * {@link workflowProcessSourceReadsOver} is the same two reads over the
 * product binding's and the package store's own seams. Neither is a hosted
 * store, and neither is in a package index.
 *
 * The package is read ONCE: a product-mode resolution carries the manifest of
 * the installed package exactly as it just read and fully verified it, so the
 * declared process member comes from that manifest. The member read itself
 * re-verifies the leaf's byte count and content digest.
 */
import { MAX_PROCESS_DEFINITION_BYTES } from "../products/constants.js";
import type { Sha256Digest } from "../products/ids.js";
import { resolveActiveProduct, resolveActiveProductFrom, type ActiveProductResolution, type ActiveProductSources } from "../products/binding/resolve.js";
import { readStoredMemberText, readStoredMemberTextFrom } from "../products/binding/manifest-authority.js";
import type { ProductPackageReads } from "../products/packages/store.js";
import type { PackageMemberRefV1 } from "../products/types.js";
import { WorkflowProcessAuthorityError } from "../workflow-history/process-authority.js";

/** The two reads one process-source lookup makes. No member takes a project root. */
export interface WorkflowProcessSourceReads {
  /** The active product binding's resolution; in product mode it carries the verified package manifest. */
  activeProduct(): Promise<ActiveProductResolution>;
  /** One declared member's strict UTF-8 text within `maxBytes`. */
  memberText(packageDigest: Sha256Digest, member: PackageMemberRefV1, maxBytes: number): Promise<string>;
}

/** LOCAL DISK. The incumbent root readers, each called when asked. */
function diskWorkflowProcessSourceReads(root: string): WorkflowProcessSourceReads {
  return {
    activeProduct: () => resolveActiveProduct(root),
    memberText: (packageDigest, member, maxBytes) => readStoredMemberText(root, packageDigest, member, maxBytes),
  };
}

/** The same reads over the binding's sources and the package store's reads. */
export function workflowProcessSourceReadsOver(product: ActiveProductSources, packages: ProductPackageReads): WorkflowProcessSourceReads {
  return {
    activeProduct: () => resolveActiveProductFrom(product),
    memberText: (packageDigest, member, maxBytes) => readStoredMemberTextFrom(packages, packageDigest, member, maxBytes),
  };
}

/** Read only the declared process member, never a caller-selected member path. */
export async function readLocalWorkflowProcessSource(root: string, expectedDigest: string | undefined): Promise<string> {
  return readLocalWorkflowProcessSourceFrom(diskWorkflowProcessSourceReads(root), expectedDigest);
}

/** THE ONE BODY: the active product and the package manifest it verified, the declared member's digest, then the member's text. */
export async function readLocalWorkflowProcessSourceFrom(reads: WorkflowProcessSourceReads, expectedDigest: string | undefined): Promise<string> {
  const active = await reads.activeProduct();
  if (active.mode !== "product") throw new WorkflowProcessAuthorityError("unavailable");
  const member = active.manifest.processDefinition;
  if (member === undefined || member.digest !== expectedDigest) {
    throw new WorkflowProcessAuthorityError("stale-or-invalid");
  }
  return reads.memberText(active.binding.packageDigest, member, MAX_PROCESS_DEFINITION_BYTES);
}
