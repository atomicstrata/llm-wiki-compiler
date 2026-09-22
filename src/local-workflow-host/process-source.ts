/**
 * @file src/local-workflow-host/process-source.ts
 * @description Read the active package's retained process-definition bytes with
 * existing binding, digest and size checks. Interpretation remains engine-owned.
 */
import { MAX_PROCESS_DEFINITION_BYTES } from "../products/constants.js";
import { resolveActiveProduct } from "../products/binding/resolve.js";
import { readStoredMemberText } from "../products/binding/manifest-authority.js";
import { readInstalledProductPackage } from "../products/packages/store.js";
import { WorkflowProcessAuthorityError } from "../workflow-history/process-authority.js";

/** Read only the declared process member, never a caller-selected member path. */
export async function readLocalWorkflowProcessSource(root: string, expectedDigest: string | undefined): Promise<string> {
  const active = await resolveActiveProduct(root);
  if (active.mode !== "product") throw new WorkflowProcessAuthorityError("unavailable");
  const stored = await readInstalledProductPackage(root, active.binding.packageDigest);
  if (stored.status !== "ok") throw new WorkflowProcessAuthorityError("unavailable");
  const member = stored.manifest.processDefinition;
  if (member === undefined || member.digest !== expectedDigest) {
    throw new WorkflowProcessAuthorityError("stale-or-invalid");
  }
  return readStoredMemberText(root, active.binding.packageDigest, member, MAX_PROCESS_DEFINITION_BYTES);
}
