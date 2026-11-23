/**
 * @file src/portable/host/local-control.ts
 * @description The local host's control plane on disk, and project registration.
 *
 * The host identity is PERSISTED: its incarnation and the secret that keys
 * operation ids are stable across CLI processes and restarts, so an id
 * allocated by one command is honoured by the next. If that identity is ever
 * lost, a fresh one is minted and old ids simply stop verifying; nothing
 * re-creates an old identity against an empty ledger.
 *
 * Registration is the one knowing opt-in. It issues a new project id for a
 * canonical root, binds the registering OS user as owner, and records the
 * portable format version and the features a binary must support. It refuses a
 * root that already carries another identity's portable ledger, and roots it
 * can recognise as sync-managed or network-backed.
 */

import { randomBytes } from "node:crypto";
import { lstat, mkdir, realpath, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureOwnerPrivateDirectory } from "../../capability-providers/packages/paths.js";
import { atomicWrite, atomicWriteNoReplaceDurable, AtomicWriteCollisionError } from "../../utils/atomic-write.js";
import { fsyncDirectory } from "../../utils/atomic-write-durability.js";
import { acquireLockBlocking, releaseLock } from "../../utils/lock.js";
import { PortableHostError } from "../errors.js";
import { PORTABLE_DIR } from "../store/disk-layout.js";
import {
  DEFAULT_HOST_LIMITS, REQUIRED_FEATURES, isSupportedRegistration, type HostControl, type HostLimits,
  type ProjectControlRecord,
} from "./control.js";
import {
  hostIdentityFile, localControlRoot, projectRecordFile, readJsonFile, registeredProjectId, rootMappingFile,
} from "./local-registry.js";

/** Owner-only mode for control-state files. */
const PRIVATE_FILE_MODE = 0o600;

/** Unknown to normal opens, so an interrupted registration cannot gain authority. */
const REGISTRATION_IN_PROGRESS = "local-registration-in-progress";

/** Path fragments of folders a sync client manages. Recognition is deliberately incomplete. */
const SYNC_MANAGED_MARKERS = [
  "/Library/Mobile Documents/", "/Library/CloudStorage/", "/Dropbox/", "/OneDrive", "/Google Drive/",
];

/** Linux filesystem magic numbers for network and userspace filesystems. */
const NON_LOCAL_FS_TYPES: ReadonlySet<number> = new Set([0x6969, 0xff534d42, 0x65735546, 0x517b, 0x01021997]);

/** The persisted identity of this user's local host. */
interface HostIdentity { incarnation: string; secret: string }

/** Write one owner-private control file atomically. */
async function writeControlFile(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWrite(file, JSON.stringify(value, null, 2), { mode: PRIVATE_FILE_MODE });
}

/**
 * Mint the host identity exactly once. It is published create-only and durably,
 * so two first opens racing each other cannot each keep an incarnation: one
 * write wins, and the loser loads and uses the winner's.
 */
async function createHostIdentity(controlRoot: string): Promise<HostIdentity> {
  const minted = { incarnation: randomBytes(16).toString("hex"), secret: randomBytes(32).toString("base64") };
  const file = hostIdentityFile(controlRoot);
  try {
    await atomicWriteNoReplaceDurable(file, JSON.stringify(minted, null, 2), { mode: PRIVATE_FILE_MODE });
    return minted;
  } catch (error) {
    if (!(error instanceof AtomicWriteCollisionError)) throw error;
  }
  const winner = await readJsonFile<HostIdentity>(file);
  if (winner === null) throw new PortableHostError("host identity could not be established");
  return winner;
}

/** The local host's control plane, backed by owner-private files outside every project. */
export class LocalHostControl implements HostControl {
  private constructor(
    private readonly controlRoot: string,
    readonly incarnation: string,
    readonly secret: Buffer,
    readonly limits: HostLimits,
  ) {}

  /** Open (creating on first use) the control plane under the per-user control root. */
  static async open(controlRoot = localControlRoot()): Promise<LocalHostControl> {
    const root = await ensureOwnerPrivateDirectory(controlRoot);
    const identity = (await readJsonFile<HostIdentity>(hostIdentityFile(root))) ?? (await createHostIdentity(root));
    return new LocalHostControl(root, identity.incarnation, Buffer.from(identity.secret, "base64"), DEFAULT_HOST_LIMITS);
  }

  loadProject(projectId: string): Promise<ProjectControlRecord | null> {
    if (!/^prj_[0-9a-f]+$/u.test(projectId)) return Promise.resolve(null);
    return readJsonFile<ProjectControlRecord>(projectRecordFile(this.controlRoot, projectId));
  }

  // Ticket issuance calls this through the HostControl interface.
  // fallow-ignore-next-line unused-class-member
  saveProject(record: ProjectControlRecord): Promise<void> {
    return writeControlFile(projectRecordFile(this.controlRoot, record.projectId), record);
  }

  /**
   * Save a project record with power-loss durability. Only format adoption
   * needs it: its exclusion of older writers must be on disk before any
   * format-2 ledger variant is, and must never revert after a crash.
   */
  async saveProjectDurably(record: ProjectControlRecord): Promise<void> {
    const file = projectRecordFile(this.controlRoot, record.projectId);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await atomicWrite(file, JSON.stringify(record, null, 2), { mode: PRIVATE_FILE_MODE, durable: true, strictDurability: true });
  }

  /** The local audit sink is a no-op in the prototype: the local owner is trusted. */
  audit(): void {}

  /** Publish a canonical root mapping exactly once, without replacing another claimant. */
  async mapRoot(canonicalRoot: string, projectId: string): Promise<void> {
    const file = rootMappingFile(this.controlRoot, canonicalRoot);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await atomicWriteNoReplaceDurable(file, JSON.stringify({ projectId, canonicalRoot }, null, 2), {
      mode: PRIVATE_FILE_MODE,
    });
  }

  /** The project registered for `root`, or `null`. */
  async projectForRoot(root: string): Promise<ProjectControlRecord | null> {
    const projectId = await registeredProjectId(root, this.controlRoot);
    return projectId === null ? null : this.loadProject(projectId);
  }
}

/** The subject the local host derives for the OS user running it. */
export function localSubject(): string {
  return `local:${os.userInfo().username}`;
}

/** Refuse roots recognisable as sync-managed or network-backed (D22). Not a complete detector. */
async function assertQualifiedRoot(canonicalRoot: string): Promise<void> {
  const marker = SYNC_MANAGED_MARKERS.find((fragment) => `${canonicalRoot}/`.includes(fragment));
  if (marker) throw new PortableHostError(`unsupported root: ${marker.trim()} looks sync-managed`);
  const type = await statfs(canonicalRoot).then((info) => Number(info.type)).catch(() => null);
  if (type !== null && NON_LOCAL_FS_TYPES.has(type)) {
    throw new PortableHostError("unsupported root: not a local regular filesystem");
  }
}

/** A portable directory already at `root` belongs to another identity: never adopted. */
async function assertNoForeignLedger(canonicalRoot: string): Promise<void> {
  const existing = await lstat(path.join(canonicalRoot, PORTABLE_DIR)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    throw new PortableHostError(
      `${PORTABLE_DIR} already exists and belongs to another registration; move it aside before registering`,
    );
  }
}

/** Create only an absent ledger; an unexpected claimant is never adopted. */
async function createLedger(canonicalRoot: string): Promise<void> {
  const ledger = path.join(canonicalRoot, PORTABLE_DIR);
  const parent = path.dirname(ledger);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (!(await lstat(parent)).isDirectory()) {
    throw new PortableHostError("portable ledger parent must be a real directory");
  }
  try {
    await mkdir(ledger, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new PortableHostError(`${PORTABLE_DIR} appeared during registration; refusing to adopt it`);
  }
  await fsyncDirectory(parent);
  await fsyncDirectory(canonicalRoot);
}

/** Resume only a pending registration with no ledger to adopt. */
async function finishPendingRegistration(
  canonicalRoot: string, record: ProjectControlRecord, control: LocalHostControl,
): Promise<ProjectControlRecord> {
  const requiredFeatures = record.requiredFeatures.filter((feature) => feature !== REGISTRATION_IN_PROGRESS);
  const completed = { ...record, requiredFeatures };
  assertUsableRegistration(completed, control);
  const ledger = path.join(canonicalRoot, PORTABLE_DIR);
  const existing = await lstat(ledger).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    throw new PortableHostError(`${PORTABLE_DIR} exists in an interrupted registration; refusing to adopt it`);
  }
  await createLedger(canonicalRoot);
  await control.saveProjectDurably(completed);
  return completed;
}

/** What registering a root reports. */
export interface RegistrationResult {
  record: ProjectControlRecord;
  /** False when the root's project identity was already published. */
  created: boolean;
  requirement: string;
}

/** Return an existing registration, completing only an unclaimed pending ledger. */
async function existingRegistration(canonicalRoot: string, control: LocalHostControl, existing: ProjectControlRecord): Promise<RegistrationResult> {
  if (existing.canonicalRoot !== canonicalRoot) {
    throw new PortableHostError("root mapping and project record disagree; refusing registration");
  }
  if (existing.requiredFeatures.includes(REGISTRATION_IN_PROGRESS)) {
    const completed = await finishPendingRegistration(canonicalRoot, existing, control);
    return { record: completed, created: false, requirement: ROOT_REQUIREMENT };
  }
  assertUsableRegistration(existing, control);
  const ledger = await lstat(path.join(canonicalRoot, PORTABLE_DIR)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (ledger === null || !ledger.isDirectory()) {
    throw new PortableHostError(`${PORTABLE_DIR} is missing from a completed registration; preserve its custody`);
  }
  return { record: existing, created: false, requirement: ROOT_REQUIREMENT };
}

/** Publish a new pending identity and make it usable only after its ledger is durable. */
async function newRegistration(canonicalRoot: string, control: LocalHostControl): Promise<RegistrationResult> {
  await assertQualifiedRoot(canonicalRoot);
  await assertNoForeignLedger(canonicalRoot);
  const projectId = `prj_${randomBytes(12).toString("hex")}`;
  const record: ProjectControlRecord = {
    projectId, tenant: "local", formatVersion: 1, requiredFeatures: [...REQUIRED_FEATURES, REGISTRATION_IN_PROGRESS],
    compartment: `${projectId}:default`, policyRevision: 1, ticketRevision: 1,
    bindings: [{ subject: localSubject(), roles: ["owner"] }], serviceGrants: [], tickets: [], canonicalRoot,
    hostIncarnation: control.incarnation,
  };
  await control.saveProjectDurably(record);
  await control.mapRoot(canonicalRoot, projectId);
  await createLedger(canonicalRoot);
  const completed = { ...record, requiredFeatures: [...REQUIRED_FEATURES] };
  await control.saveProjectDurably(completed);
  return { record: completed, created: true, requirement: ROOT_REQUIREMENT };
}

const ROOT_REQUIREMENT =
  "Supported only on a local regular filesystem with cooperating writers; network and sync-managed folders are not supported, and not every such folder can be recognised.";

/**
 * Register a project directory for the portable path.
 *
 * Registering an already-registered root is idempotent ONLY while that
 * registration is usable: it is checked exactly as an open checks it, so a
 * registration this binary cannot honour, or one issued by a host identity that
 * no longer exists, is refused rather than reported as `created: false`.
 *
 * @param root - The project directory. Its canonical path is what gets bound.
 * @param controlRoot - The host control root (defaults to the per-user one).
 * @throws PortableHostError when the existing registration is unusable (see {@link assertUsableRegistration}),
 *   or the root is unqualified or already carries a portable directory.
 */
export async function registerLocalProject(root: string, controlRoot?: string): Promise<RegistrationResult> {
  const canonicalRoot = await realpath(root);
  const lockRoot = await ensureOwnerPrivateDirectory(controlRoot ?? localControlRoot());
  await acquireLockBlocking(lockRoot);
  try {
    const control = await LocalHostControl.open(lockRoot);
    const existing = await control.projectForRoot(canonicalRoot);
    return await (existing !== null
      ? existingRegistration(canonicalRoot, control, existing)
      : newRegistration(canonicalRoot, control));
  } finally {
    await releaseLock(lockRoot);
  }
}

/**
 * Refuse a registration this binary cannot honour: an unsupported format or
 * feature set (D24), or one issued by a host identity that no longer exists.
 *
 * The second case fails closed and is NOT repaired by registering again: the
 * registration, its root mapping and the project's portable ledger (which may
 * hold unresolved intents and custody) are left exactly as they are. The only
 * recovery is restoring the original host identity from a verified backup
 * whose incarnation matches the registration's; without one it stays
 * unresolved. Nothing here restores, replaces, moves or deletes anything.
 */
export function assertUsableRegistration(record: ProjectControlRecord, control: HostControl): void {
  if (!isSupportedRegistration(record)) {
    throw new PortableHostError("this project requires a newer portable format or feature set");
  }
  if (record.hostIncarnation !== control.incarnation) {
    throw new PortableHostError(
      `this project was registered under host identity ${record.hostIncarnation}, which no longer exists here; registering again cannot recover it. `
      + "Keep the host-control state and the project's portable ledger as they are, and restore the original host identity only from a verified backup that matches that identity.",
    );
  }
}
