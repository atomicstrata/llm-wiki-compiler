/**
 * @file src/capability-providers/packages/install-persistence.ts
 * @description Transactional provider-install state publication. A cache or
 * tree binding failure after the state write restores the exact prior state,
 * so a rejected install never leaves an authoritative record behind.
 */
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import {
  assertAuthorizedProviderDirectory, type AuthorizedProviderDirectory,
  type AuthorizedProviderPaths,
} from "./paths.js";
import { readProviderInstallState, writeProviderInstallState } from "./state-store.js";
import type {
  ProviderInstallRecordV1, ProviderLocalApprovalV1,
} from "./state-types.js";

/** Installed evidence plus the immutable tree path used by later resolution. */
export interface InstalledProviderSnapshot extends ProviderInstallRecordV1 {
  readonly treePath: string;
}

/** Persist one install record only while its digest and tree bindings remain valid. */
export async function persistProviderInstall(
  paths: AuthorizedProviderPaths,
  directory: AuthorizedProviderDirectory,
  tree: AuthorizedProviderDirectory,
  record: ProviderInstallRecordV1,
  afterCommit?: (directory: string) => Promise<void>,
): Promise<InstalledProviderSnapshot> {
  await assertAuthorizedProviderDirectory(paths, directory);
  await assertAuthorizedProviderDirectory(paths, tree);
  const state = await readProviderInstallState(paths);
  const existing = state.installs[record.packageDigest];
  const changed = !existing || canonicalDigest(existing) !== canonicalDigest(record);
  try {
    if (changed) {
      await writeProviderInstallState(paths, {
        schemaVersion: 1, installs: Object.freeze({ ...state.installs, [record.packageDigest]: record }),
        localApprovals: nextLocalApprovals(state.localApprovals, record),
      });
      await afterCommit?.(directory.path);
    }
    await assertAuthorizedProviderDirectory(paths, directory);
    await assertAuthorizedProviderDirectory(paths, tree);
    return Object.freeze({ ...record, treePath: tree.path });
  } catch (error) {
    if (changed) await restoreInstallState(paths, state, error);
    throw error;
  }
}

function nextLocalApprovals(
  approvals: Readonly<Record<string, ProviderLocalApprovalV1>>,
  record: ProviderInstallRecordV1,
): Readonly<Record<string, ProviderLocalApprovalV1>> {
  if (record.sourceType === "local-development" || !(record.packageDigest in approvals)) return approvals;
  const next = { ...approvals };
  delete next[record.packageDigest];
  return Object.freeze(next);
}

async function restoreInstallState(
  paths: AuthorizedProviderPaths,
  state: Awaited<ReturnType<typeof readProviderInstallState>>,
  cause: unknown,
): Promise<void> {
  try {
    await writeProviderInstallState(paths, state);
  } catch (rollbackError) {
    throw new AggregateError([cause, rollbackError], "provider install-state rollback failed");
  }
}
