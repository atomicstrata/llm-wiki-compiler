/**
 * @file src/profile/templates/publish/add.ts
 * @description Validate, sign, and record one template package into the workspace.
 *
 * The package is validated by the PRODUCTION validator and its envelope is proved to
 * parse under the PRODUCTION parser before it is recorded — a publisher never records
 * bytes that a consumer would refuse. Coordinates are immutable: the same coordinate
 * may never resolve to different bytes.
 */
import packageJson from "../../../../package.json" with { type: "json" };
import { readCappedNoFollow } from "../../../utils/confined-read.js";
import { withExclusiveLock } from "../../../utils/exclusive-lock.js";
import { canonicalDigest, packageClaim } from "../signing/canonical.js";
import { parseSignedPackage, parseTemplateCoordinate } from "../signing/protocol.js";
import { signClaim } from "../signing/sign.js";
import { validateTemplatePackage } from "../validate.js";
import { readPrivateKey } from "./keystore.js";
import type { WorkspacePaths } from "./workspace-paths.js";
import { readWorkspace, writeWorkspace } from "./workspace-store.js";
import type { PublisherWorkspace, WorkspacePackage } from "./workspace-types.js";

const MAX_PACKAGE_FILE_BYTES = 2 * 1024 * 1024;

/** Result of accepting one package into the workspace. */
export interface AddPackageResult {
  coordinate: string;
  payloadDigest: string;
  alreadyPresent: boolean;
}

/** Validate, sign, and record one template package under the workspace lock. */
export async function addPackage(
  paths: WorkspacePaths,
  packageFile: string,
  version: string,
): Promise<AddPackageResult> {
  return withExclusiveLock(paths, async () => {
    const workspace = await readWorkspace(paths);
    const pkg = await readValidatedPackage(packageFile);
    if (pkg.publisher !== workspace.publisher) {
      throw new Error(`package publisher '${pkg.publisher}' is not this workspace's publisher '${workspace.publisher}'`);
    }
    if (pkg.version !== version) {
      throw new Error(`package version '${pkg.version}' does not match the requested version '${version}'`);
    }
    const coordinate = `${workspace.tap}/${workspace.publisher}/${pkg.templateId}@${version}`;
    parseTemplateCoordinate(coordinate);
    const payloadDigest = canonicalDigest(pkg);

    const existing = workspace.coordinates[coordinate];
    if (existing !== undefined) {
      if (existing !== payloadDigest) {
        throw new Error(`coordinate is immutable and already resolves to different bytes: ${coordinate}`);
      }
      return { coordinate, payloadDigest, alreadyPresent: true };
    }

    const recorded = await signPackage(paths, workspace, coordinate, payloadDigest, pkg);
    await writeWorkspace(paths, {
      ...workspace,
      packages: [...workspace.packages, recorded],
      coordinates: { ...workspace.coordinates, [coordinate]: payloadDigest },
    });
    return { coordinate, payloadDigest, alreadyPresent: false };
  });
}

/** Sign the package claim and prove the envelope parses before recording it. */
async function signPackage(
  paths: WorkspacePaths,
  workspace: PublisherWorkspace,
  coordinate: string,
  payloadDigest: string,
  payload: unknown,
): Promise<WorkspacePackage> {
  const key = await readPrivateKey(paths, "publisher", workspace.publisherKey.keyId);
  const publisherSignature = signClaim(packageClaim(coordinate, payloadDigest), key);
  const envelope = { schemaVersion: 1, coordinate, payload, payloadDigest, publisherSignature };
  const envelopeJson = JSON.stringify(envelope);
  parseSignedPackage(envelopeJson);
  return {
    coordinate,
    publisher: workspace.publisher,
    payloadDigest,
    publisherSignature,
    envelopeJson,
  };
}

/** Read one operator-supplied package file through the production validator. */
async function readValidatedPackage(packageFile: string) {
  const read = await readCappedNoFollow(packageFile, MAX_PACKAGE_FILE_BYTES);
  if (read.kind !== "ok") throw new Error("template package file is missing, symlinked, or unreadable");
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.body);
  } catch (error) {
    throw new Error(`template package file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateTemplatePackage(parsed, {
    currentVersion: packageJson.version,
    sourceType: "remote",
  });
}
