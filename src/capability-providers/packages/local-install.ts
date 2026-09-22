/**
 * @file src/capability-providers/packages/local-install.ts
 * @description Explicit local-development snapshot installation. Source bytes
 * are copied through no-follow handles into immutable digest-addressed custody
 * and are always recorded as local-unverified evidence.
 */
import { createHash } from "node:crypto";
import {
  MAX_EXPANDED_PACKAGE_TREE_BYTES,
} from "../constants.js";
import type { Sha256Digest } from "../types.js";
import { parseSha256Digest } from "../ids.js";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { writeProviderTree, type ProviderTreeEntry } from "./archive-filesystem.js";
import {
  publishPreparedProviderLocked, type InstalledProviderSnapshot,
} from "./builtin.js";
import {
  assertTestAuthorizedProviderPaths, providerClockNow, type AuthorizedProviderPaths,
} from "./paths.js";
import {
  parseCapabilityProviderPackage, selectHostPlatformArtifact, type PlatformArtifactV1,
} from "./protocol.js";
import {
  readProviderInstallState, withProviderStateLock, writeProviderInstallState,
} from "./state-store.js";
import type { ProviderLocalApprovalV1 } from "./state-types.js";
import {
  snapshotLocalProviderTree, type LocalProviderSnapshotOptions,
} from "./local-snapshot.js";

interface TreeRecord { readonly path: string; readonly digest: string; readonly byteCount: number }

export interface InstallLocalProviderRequest {
  readonly sourceRoot: string;
  readonly payload: unknown;
  readonly confirmedPackageDigest: string;
  /** @internal Deterministic race and small-cap fixtures on test-authorized roots. */
  readonly snapshotOptionsForTest?: LocalProviderSnapshotOptions;
}

export interface ApproveLocalProviderExecutionRequest {
  readonly packageDigest: string;
  readonly confirmed: boolean;
}

/** Snapshot an explicitly confirmed local package without executing its code. */
export async function installLocalProvider(
  paths: AuthorizedProviderPaths,
  request: InstallLocalProviderRequest,
): Promise<InstalledProviderSnapshot> {
  const snapshotOptions = request.snapshotOptionsForTest;
  if (snapshotOptions) await assertTestAuthorizedProviderPaths(paths);
  const payload = parseCapabilityProviderPackage(request.payload);
  const packageDigest = canonicalDigest(payload) as Sha256Digest;
  if (request.confirmedPackageDigest !== packageDigest) {
    throw new Error("local provider confirmation does not match the package digest");
  }
  const artifact = selectHostPlatformArtifact(payload);
  const coordinate = `local/${payload.publisher}/${payload.providerId}@${payload.providerVersion}`;
  return withProviderStateLock(paths, () => publishPreparedProviderLocked(paths, {
    payload, artifact, packageDigest, coordinate, sourceType: "local-development",
    packageEvidenceText: `${JSON.stringify(payload)}\n`, tapSequence: null,
    publisherKeyId: null, acceptedIndexDigest: null,
    installedAt: providerClockNow(paths),
  }, (tree, expectedParentReal) => (
    snapshotLocalTree(request.sourceRoot, tree, artifact, expectedParentReal, snapshotOptions)
  )));
}

/** Record a distinct operator confirmation for exact local package bytes. */
export async function approveLocalProviderExecution(
  paths: AuthorizedProviderPaths,
  request: ApproveLocalProviderExecutionRequest,
): Promise<ProviderLocalApprovalV1> {
  if (!request.confirmed) throw new Error("local provider execution requires explicit confirmation");
  const packageDigest = parseSha256Digest(request.packageDigest);
  return withProviderStateLock(paths, async () => {
    const state = await readProviderInstallState(paths);
    if (state.installs[packageDigest]?.sourceType !== "local-development") {
      throw new Error("local provider execution approval requires a local-development install");
    }
    const existing = state.localApprovals[packageDigest];
    if (existing) return existing;
    const approval = Object.freeze({
      packageDigest,
      approvedAt: providerClockNow(paths).toISOString(),
    });
    await writeProviderInstallState(paths, {
      schemaVersion: 1,
      installs: state.installs,
      localApprovals: Object.freeze({ ...state.localApprovals, [packageDigest]: approval }),
    });
    return approval;
  });
}

async function snapshotLocalTree(
  sourceRoot: string,
  destination: string,
  artifact: PlatformArtifactV1,
  expectedParentReal: string,
  options: LocalProviderSnapshotOptions = {},
): Promise<void> {
  const files = await snapshotLocalProviderTree(sourceRoot, options);
  assertTreeClaims(files, artifact);
  await writeProviderTree(destination, files, artifact.entrypointRelativePath, { expectedParentReal });
}

function assertTreeClaims(files: readonly ProviderTreeEntry[], artifact: PlatformArtifactV1): void {
  const bytes = files.reduce((sum, file) => sum + file.body.length, 0);
  const records = files.map(treeRecord).sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
  if (bytes > MAX_EXPANDED_PACKAGE_TREE_BYTES || files.length !== artifact.entryCount
    || bytes !== artifact.expandedByteCount || canonicalDigest(records) !== artifact.expandedTreeDigest
    || !files.some((file) => file.relative === artifact.entrypointRelativePath)) {
    throw new Error("local provider tree differs from declared package metadata");
  }
}

function treeRecord(file: ProviderTreeEntry): TreeRecord {
  return {
    path: file.relative,
    digest: `sha256:${createHash("sha256").update(file.body).digest("hex")}`,
    byteCount: file.body.length,
  };
}
