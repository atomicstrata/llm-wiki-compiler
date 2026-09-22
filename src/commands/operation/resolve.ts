/**
 * @file src/commands/operation/resolve.ts
 * @description Shared resolution helpers for the `llmwiki operation` command
 * group: read a run leaf for a resolved target, and construct the operator
 * principal + approve request the recovery-drive seams consume.
 *
 * TARGET RESOLUTION ITSELF MOVED DOWN to `operation-bundles/bundle-target.ts`
 * and is re-exported here unchanged. `product apply` names a bundle exactly as
 * this group does, and a second copy of "a target matches a run id or a bundle
 * id" is how the two surfaces come to disagree about what an operator typed.
 *
 * PRINCIPAL, NOT TRANSPORT (design v2 section 14.2): a local CLI caller already
 * possesses shell/filesystem access and can acquire the project lock, so it holds
 * local project-operator authority. Constructing a `cli`-surface principal that
 * carries the operator grants is therefore the sanctioned local authority, not
 * fabricated elevation. The drive request builds its runtime through
 * `createCliOperationRuntime` — the CLI-only constructor that installs the
 * production operations-authority resolver — so the seams recompute the authority
 * snapshot from current state, park on genuine drift, and fail closed on
 * unreadable/absent backing state.
 */

import { readOperationKey } from "../../operation-bundles/key-epoch.js";
import { readOperationRun, type OperationRunRead } from "../../operation-bundles/run-store.js";
import { createCliOperationRuntime } from "../../operation-bundles/runtime-factory.js";
import type { ApproveOperationBundleRequest } from "../../operation-bundles/executor.js";
import type { OperationGrant, OperationPrincipal } from "../../operation-bundles/principal.js";
import type { OperationRun } from "../../operation-bundles/run-types.js";
import type { OperationDigest } from "../../operation-bundles/types.js";
import {
  loadOperationInventory, resolveTarget, type ResolvedTarget,
} from "../../operation-bundles/bundle-target.js";

/**
 * Target resolution itself lives in the domain, because `product apply` names a
 * bundle the same way this group does and the lookup must be ONE rule. These
 * re-exports keep every command in the group importing from its own host module.
 */
export {
  loadOperationInventory, resolvedFromManifest, resolveTarget, type ResolvedTarget,
} from "../../operation-bundles/bundle-target.js";
import { CLI_OPERATOR_ID } from "../../cli/shared.js";

/** Read the project key epoch, or null when no key leaf is readable. */
export async function readKeyEpoch(root: string): Promise<OperationDigest | null> {
  const key = await readOperationKey(root);
  return key.status === "ok" ? key.keyEpochId : null;
}

/** Read one manifest's run leaf under the given key epoch. */
export function readRunForTarget(
  root: string,
  resolved: ResolvedTarget,
  keyEpochId: OperationDigest,
): Promise<OperationRunRead> {
  return readOperationRun(root, {
    runId: resolved.runId,
    bundleId: resolved.bundleId,
    manifestDigest: resolved.manifestDigest,
    workspaceId: resolved.workspaceId,
    keyEpochId,
  });
}

/** A resolved target paired with its authenticated run, or a bounded error message. */
export type TargetRun = { resolved: ResolvedTarget; run: OperationRun } | { error: string };

/** Human-readable reason a resolved target's run leaf could not be read as ok. */
function runReadError(resolved: ResolvedTarget, read: Exclude<OperationRunRead, { status: "ok" }>): string {
  const why = read.status === "absent" ? "absent" : `unreadable (${read.detail})`;
  return `Run ${resolved.runId} is ${why}.`;
}

/**
 * Resolve a target and read its authenticated run, or return a bounded error.
 * The shared read preamble for `inspect` and `cancel`, so both surface identical
 * not-found / no-key / unreadable messages.
 *
 * @param root - The project root.
 * @param target - A run id or bundle id.
 */
export async function resolveTargetRun(root: string, target: string): Promise<TargetRun> {
  const inventory = await loadOperationInventory(root);
  const resolved = resolveTarget(inventory, target);
  if (resolved === null) return { error: `No operation bundle or run matches "${target}".` };
  const keyEpochId = await readKeyEpoch(root);
  if (keyEpochId === null) return { error: `No readable operation key for ${resolved.runId}.` };
  const read = await readRunForTarget(root, resolved, keyEpochId);
  if (read.status !== "ok") return { error: runReadError(resolved, read) };
  return { resolved, run: read.run };
}

/**
 * Construct the local CLI operator principal carrying the given grants.
 *
 * EXPORTED for the sibling `product` host, whose `apply` verb acts under the
 * same local project-operator authority for the same reason (§14.2). One
 * construction means the id and the stamped surface cannot drift between the
 * two groups that approve bundles.
 */
export function cliOperatorPrincipal(grants: readonly OperationGrant[]): OperationPrincipal {
  return { id: CLI_OPERATOR_ID, surface: "cli", grants };
}

/** Build the recovery-drive request for a resolved target under the production runtime. */
export function buildDriveRequest(
  resolved: ResolvedTarget,
  grants: readonly OperationGrant[],
): ApproveOperationBundleRequest {
  return {
    workspaceId: resolved.workspaceId,
    bundleId: resolved.bundleId,
    manifestDigest: resolved.manifestDigest,
    principal: cliOperatorPrincipal(grants),
    runtime: createCliOperationRuntime(),
  };
}
