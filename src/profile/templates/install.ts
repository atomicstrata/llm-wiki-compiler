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
import { getBuiltinTemplate } from "./registry.js";
import type { ProfileTemplatePackage, TemplateLock, TemplateSourceType } from "./types.js";
import { validateTemplatePackage } from "./validate.js";

const TEMPLATE_LOCK_FILE = ".llmwiki/template-lock.json";
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
  options: TemplateInstallOptions & { sourceType: TemplateSourceType },
): Promise<TemplateInstallResult> {
  await acquireLockBlocking(root);
  try {
    const loaded = await loadProfile(root);
    if (loaded.loadedFrom !== null && !options.force) {
      throw new TemplateInstallError("A profile already exists. Re-run with --force only when the typed corpus is empty.");
    }
    const probe = await isTypedCorpusEmpty(root, loaded, pkg.profile);
    if (!probe.empty) {
      throw new TemplateInstallError(`Refusing to replace the active profile: typed corpus is not empty.\n- ${probe.reasons.join("\n- ")}`);
    }
    await writeProfile(root, pkg);
    const lockWritten = await tryWriteLock(root, pkg, options.sourceType);
    return { kind: "installed", templateId: pkg.templateId, version: pkg.version, lockWritten };
  } finally {
    await releaseLock(root);
  }
}

async function writeProfile(root: string, pkg: ProfileTemplatePackage): Promise<void> {
  const body = `${JSON.stringify(pkg.profile, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_PROFILE_BYTES) {
    throw new TemplateInstallError(`${PROFILE_FILE} would exceed the ${MAX_PROFILE_BYTES}-byte profile cap`);
  }
  await atomicWrite(path.join(root, PROFILE_FILE), body, { confineRoot: root, durable: true });
}

async function tryWriteLock(root: string, pkg: ProfileTemplatePackage, sourceType: TemplateSourceType): Promise<boolean> {
  try {
    await writeLock(root, pkg, sourceType);
    return true;
  } catch {
    return false;
  }
}

async function writeLock(root: string, pkg: ProfileTemplatePackage, sourceType: TemplateSourceType): Promise<void> {
  const lock: TemplateLock = {
    schemaVersion: 1,
    templateId: pkg.templateId,
    version: pkg.version,
    publisher: pkg.publisher,
    sourceType,
    installedAt: new Date().toISOString(),
    profileDigest: profileDigest(pkg.profile),
  };
  await atomicWrite(path.join(root, TEMPLATE_LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`, { confineRoot: root, durable: true });
}
