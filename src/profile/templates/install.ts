/**
 * @file src/profile/templates/install.ts
 * @description Installs validated profile template packages into .llmwiki/profile.json.
 */
import path from "node:path";
import packageJson from "../../../package.json";
import { readCappedNoFollow } from "../../utils/confined-read.js";
import { MAX_PROFILE_BYTES, PROFILE_FILE } from "../../utils/constants.js";
import { acquireLockBlocking, releaseLock } from "../../utils/lock.js";
import { atomicWrite } from "../../utils/markdown.js";
import { profileDigest } from "../digest.js";
import { loadProfile } from "../load.js";
import { isTypedCorpusEmpty } from "./corpus.js";
import { TEMPLATE_LOCK_FILE } from "./lock.js";
import { getBuiltinTemplate } from "./registry.js";
import { parseTemplateCoordinate } from "./signing/protocol.js";
import { withTapStateLock } from "./taps/operator-lock.js";
import { resolveRemotePackage, type ResolvedRemotePackage } from "./taps/package.js";
import type { TapPaths } from "./taps/paths.js";
import type {
  ProfileTemplatePackage,
  RemoteTemplateProvenance,
  TemplateLock,
  TemplateSourceType,
} from "./types.js";
import { validateTemplatePackage } from "./validate.js";

const MAX_TEMPLATE_PACKAGE_BYTES = MAX_PROFILE_BYTES * 2;

/** Options controlling profile template installation. */
export interface TemplateInstallOptions {
  force: boolean;
  currentVersion?: string;
}

/** Successful template install result surfaced to CLI callers. */
export interface TemplateInstallResult {
  kind: "installed";
  templateId: string;
  version: string;
  lockWritten: boolean;
}

/** Inputs used to build non-authoritative template provenance. */
export interface TemplateLockOptions {
  sourceType: TemplateSourceType;
  remote?: RemoteTemplateProvenance;
}

interface InstallPackageOptions extends TemplateInstallOptions, TemplateLockOptions {}

/** Error raised when template init refuses to write. */
class TemplateInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateInstallError";
  }
}

/** Install one builtin template by id. */
export async function installBuiltinTemplate(root: string, id: string, options: TemplateInstallOptions): Promise<TemplateInstallResult> {
  if (id === "default") {
    throw new TemplateInstallError("The default profile is already active when .llmwiki/profile.json is absent. No file was written.");
  }
  const builtin = getBuiltinTemplate(id);
  if (!builtin) throw new TemplateInstallError(`Unknown template: ${id}`);
  const currentVersion = options.currentVersion ?? packageJson.version;
  const pkg = validateTemplatePackage(builtin, { currentVersion, sourceType: "builtin" });
  return installPackage(root, pkg, { ...options, sourceType: "builtin" });
}

/** Install one local template package from an operator-supplied JSON file. */
export async function installLocalTemplate(root: string, filePath: string, options: TemplateInstallOptions): Promise<TemplateInstallResult> {
  const parsed = await readLocalPackageJson(filePath);
  const currentVersion = options.currentVersion ?? packageJson.version;
  const pkg = validateTemplatePackage(parsed, { currentVersion, sourceType: "local" });
  return installPackage(root, pkg, { ...options, sourceType: "local" });
}

/** Install one fully verified remote release through the shared locked path. */
export async function installRemoteTemplate(
  root: string,
  paths: TapPaths,
  resolved: ResolvedRemotePackage,
  options: TemplateInstallOptions,
): Promise<TemplateInstallResult> {
  if (resolved.indexExpired) throw new TemplateInstallError("Remote template evidence is stale; refresh its tap before installing.");
  await acquireLockBlocking(root);
  try {
    return await withTapStateLock(paths, async () => {
      const current = await resolveRemotePackage(paths, resolved.coordinate, { offline: true });
      assertSameRemoteResolution(resolved, current);
      const pkg = validatedRemotePackage(current, options.currentVersion ?? packageJson.version);
      return installPackageLocked(root, pkg, remoteInstallOptions(options, current));
    });
  } finally {
    await releaseLock(root);
  }
}

function validatedRemotePackage(resolved: ResolvedRemotePackage, currentVersion: string): ProfileTemplatePackage {
  if (resolved.indexExpired) throw new TemplateInstallError("Remote template evidence is stale; refresh its tap before installing.");
  const pkg = validateTemplatePackage(resolved.package, { currentVersion, sourceType: "remote" });
  const coordinate = parseTemplateCoordinate(resolved.coordinate);
  assertRemoteIdentity(pkg, coordinate.publisher, coordinate.templateId, coordinate.version);
  return pkg;
}

function assertSameRemoteResolution(expected: ResolvedRemotePackage, current: ResolvedRemotePackage): void {
  if (expected.coordinate !== current.coordinate
    || expected.payloadDigest !== current.payloadDigest
    || expected.publisherKeyId !== current.publisherKeyId
    || expected.tapSequence !== current.tapSequence) {
    throw new TemplateInstallError("Remote template evidence changed before installation; review it again.");
  }
}

function remoteInstallOptions(
  options: TemplateInstallOptions,
  resolved: ResolvedRemotePackage,
): InstallPackageOptions {
  const coordinate = parseTemplateCoordinate(resolved.coordinate);
  return {
    ...options,
    sourceType: "remote",
    remote: {
      coordinate: resolved.coordinate,
      packageDigest: resolved.payloadDigest,
      tap: coordinate.tap,
      indexSequence: resolved.tapSequence,
      publisherKeyId: resolved.publisherKeyId,
      verifiedAt: new Date().toISOString(),
    },
  };
}

function assertRemoteIdentity(
  pkg: ProfileTemplatePackage,
  publisher: string,
  templateId: string,
  version: string,
): void {
  if (pkg.publisher !== publisher || pkg.templateId !== templateId || pkg.version !== version) {
    throw new TemplateInstallError("Verified package identity does not match its remote coordinate.");
  }
}

async function readLocalPackageJson(filePath: string): Promise<unknown> {
  try {
    const read = await readCappedNoFollow(filePath, MAX_TEMPLATE_PACKAGE_BYTES);
    if (read.kind !== "ok") throw new Error(read.kind);
    return JSON.parse(read.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TemplateInstallError(`Invalid template JSON: ${message}`);
  }
}

async function installPackage(
  root: string,
  pkg: ProfileTemplatePackage,
  options: InstallPackageOptions,
): Promise<TemplateInstallResult> {
  await acquireLockBlocking(root);
  try {
    return await installPackageLocked(root, pkg, options);
  } finally {
    await releaseLock(root);
  }
}

async function installPackageLocked(
  root: string,
  pkg: ProfileTemplatePackage,
  options: InstallPackageOptions,
): Promise<TemplateInstallResult> {
  const loaded = await loadProfile(root);
  if (loaded.loadedFrom !== null && !options.force) {
    throw new TemplateInstallError("A profile already exists. Re-run with --force only when the typed corpus is empty.");
  }
  const probe = await isTypedCorpusEmpty(root, loaded, pkg.profile);
  if (!probe.empty) {
    throw new TemplateInstallError(`Refusing to replace the active profile: typed corpus is not empty.\n- ${probe.reasons.join("\n- ")}`);
  }
  await writeInstalledProfile(root, pkg);
  const lockWritten = await tryWriteLock(root, pkg, options);
  return { kind: "installed", templateId: pkg.templateId, version: pkg.version, lockWritten };
}

/** Durably write one validated package profile under project confinement. */
export async function writeInstalledProfile(root: string, pkg: ProfileTemplatePackage): Promise<void> {
  const body = `${JSON.stringify(pkg.profile, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_PROFILE_BYTES) {
    throw new TemplateInstallError(`${PROFILE_FILE} would exceed the ${MAX_PROFILE_BYTES}-byte profile cap`);
  }
  await atomicWrite(path.join(root, PROFILE_FILE), body, { confineRoot: root, durable: true });
}

async function tryWriteLock(root: string, pkg: ProfileTemplatePackage, options: InstallPackageOptions): Promise<boolean> {
  try {
    await writeAdvisoryTemplateLock(root, buildTemplateLock(pkg, options));
    return true;
  } catch {
    return false;
  }
}

/** Build advisory provenance from validated package and verified source metadata. */
export function buildTemplateLock(pkg: ProfileTemplatePackage, options: TemplateLockOptions): TemplateLock {
  return {
    schemaVersion: 2,
    templateId: pkg.templateId,
    version: pkg.version,
    publisher: pkg.publisher,
    sourceType: options.sourceType,
    installedAt: new Date().toISOString(),
    profileDigest: profileDigest(pkg.profile),
    ...(options.remote ? { remote: options.remote } : {}),
  };
}

/** Durably write advisory provenance; callers must not treat it as authority. */
export async function writeAdvisoryTemplateLock(root: string, lock: TemplateLock): Promise<void> {
  await atomicWrite(path.join(root, TEMPLATE_LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`, { confineRoot: root, durable: true });
}
