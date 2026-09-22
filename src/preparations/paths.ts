/**
 * @file src/preparations/paths.ts
 * @description Pure lexical construction for every Orchestration V2 preparation
 * store root and leaf (design sections 8 and 9.3). Every caller-influenced path
 * component is validated through the shared safe grammar plus store-local
 * control/normalization/portability guards before it joins a path; this module
 * performs no filesystem reads, directory creation, or realpath resolution. It
 * is the first of the two path-enforcement layers: the second is the no-follow
 * realpath re-confinement performed immediately before every I/O.
 */

import path from "node:path";
import { Buffer } from "node:buffer";
import { isSafeFilenameComponent } from "../profile/identity.js";
import { isWellFormedUnicode } from "../utils/well-formed-unicode.js";
import {
  assertPreparationId, assertPreparationRunId, assertSafeComponent,
  type PreparationId, type PreparationRunId,
} from "./ids.js";
import { MAX_SAFE_COMPONENT_BYTES } from "./constants.js";
import { PreparationIdentityError } from "./problems.js";

const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const PORTABLE_DIRECTORY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PORTABLE_QUARANTINE_DIRECTORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const QUARANTINE_UNIT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WINDOWS_DEVICE_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** The project-global preparation key filename (design section 12.1). */
const PREPARATION_KEY_FILENAME = "preparation-runs.runkey";

/** The reserved manifest filename beneath one preparation directory. */
export const MANIFEST_FILENAME = "manifest.json";

/** The reserved evidence directory segment beneath one preparation. */
export const EVIDENCE_SEGMENT = "evidence";

/** The reserved preparation, run, quarantine, and prune directory segments. */
export const PREPARATIONS_SEGMENT = "preparations";
export const PREPARATION_RUNS_SEGMENT = "preparation-runs";
export const PREPARATION_QUARANTINE_SEGMENT = "preparation-quarantine";
/** Filename prefix for one leaf staged mid-delete inside its prune unit. */
/** Implementation detail of `lifecycleStagedDeleteName`, the one derivation. */
const STAGED_DELETE_PREFIX = "pending-delete-";

/**
 * The staged-delete slot name for one planned object index.
 *
 * ONE derivation, in the layer BELOW both consumers. It was computed twice --
 * privately by the delete executor in `lifecycle-fs`, publicly by the
 * postcondition classifier in `lifecycle-snapshot` -- so the code that STAGED a
 * file and the code that CLASSIFIES it agreed only by coincidence.
 *
 * It lives here rather than in either consumer because the first dedup pointed
 * the filesystem layer at the snapshot layer and inverted the dependency; the
 * architecture control caught it. A shared derivation belongs under everything
 * that shares it.
 */
export function lifecycleStagedDeleteName(index: number): string {
  return `${STAGED_DELETE_PREFIX}${String(index).padStart(6, "0")}`;
}

/** The registry directory holding every prune and sweep tombstone unit. */
export const PREPARATION_PRUNE_REGISTRY = "preparation-prune";
const PREPARATION_PRUNE_SEGMENT = PREPARATION_PRUNE_REGISTRY;

/** Fixed owned roots and validated leaf constructors for one workspace. */
export interface PreparationPaths {
  preparationKeyFile: string;
  workspacesRoot: string;
  quarantineRoot: string;
  workspaceRoot: string;
  preparationsRoot: string;
  runsRoot: string;
  preparationRoot(preparationId: PreparationId): string;
  manifestFile(preparationId: PreparationId): string;
  evidenceRoot(preparationId: PreparationId): string;
  evidenceFile(preparationId: PreparationId, digest: string): string;
  runFile(runId: PreparationRunId): string;
  cancelFile(runId: PreparationRunId): string;
}

/**
 * Layer preparation-local control, well-formedness, NFC, portability, and
 * Windows-device guards over the shared safe-component grammar. A workspace id
 * that passed the plan's looser `component()` grammar but carries a control
 * character, denormalized form, or reserved device basename fails closed here,
 * before it can select a physical directory partition.
 */
function assertWorkspaceDirectoryId(value: unknown): string {
  const component = assertSafeComponent(value);
  if (
    CONTROL_CHARACTER.test(component) ||
    !isWellFormedUnicode(component) ||
    component.normalize("NFC") !== component ||
    Buffer.byteLength(component, "utf8") > MAX_SAFE_COMPONENT_BYTES ||
    !isSafeFilenameComponent(component) ||
    !PORTABLE_DIRECTORY_ID.test(component) ||
    WINDOWS_DEVICE_BASENAME.test(component)
  ) {
    throw new PreparationIdentityError("safe-component");
  }
  return component;
}

/** Validate one workspace id before it enters a preparation path join. */
export function assertWorkspaceId(value: unknown): string {
  return assertWorkspaceDirectoryId(value);
}

/** Validate and return one lowercase SHA-256 evidence filename. */
function assertLowercaseSha256(value: unknown): string {
  if (typeof value !== "string" || !LOWERCASE_SHA256.test(value)) {
    throw new PreparationIdentityError("safe-component");
  }
  return value;
}

/** Build preparation-owned leaf constructors beneath a validated preparations root. */
function preparationLeaves(preparationsRoot: string) {
  const preparationRoot = (preparationId: PreparationId) =>
    path.join(preparationsRoot, assertPreparationId(preparationId));
  const manifestFile = (preparationId: PreparationId) =>
    path.join(preparationRoot(preparationId), MANIFEST_FILENAME);
  const evidenceRoot = (preparationId: PreparationId) =>
    path.join(preparationRoot(preparationId), EVIDENCE_SEGMENT);
  const evidenceFile = (preparationId: PreparationId, digest: string) =>
    path.join(evidenceRoot(preparationId), assertLowercaseSha256(digest));
  return { preparationRoot, manifestFile, evidenceRoot, evidenceFile };
}

/** Build run-owned leaf constructors beneath a validated runs root. */
function runLeaves(runsRoot: string) {
  const runFile = (runId: PreparationRunId) =>
    path.join(runsRoot, `${assertPreparationRunId(runId)}.json`);
  const cancelFile = (runId: PreparationRunId) =>
    path.join(runsRoot, `${assertPreparationRunId(runId)}.cancel`);
  return { runFile, cancelFile };
}

/** Return the complete lexical preparation-store layout for one workspace. */
export function preparationPaths(root: string, workspaceId: string): PreparationPaths {
  const llmwikiRoot = path.join(root, ".llmwiki");
  const workspacesRoot = path.join(llmwikiRoot, "workspaces");
  const workspaceRoot = path.join(workspacesRoot, assertWorkspaceId(workspaceId));
  const preparationsRoot = path.join(workspaceRoot, PREPARATIONS_SEGMENT);
  const runsRoot = path.join(workspaceRoot, PREPARATION_RUNS_SEGMENT);
  return {
    preparationKeyFile: path.join(llmwikiRoot, PREPARATION_KEY_FILENAME),
    workspacesRoot,
    quarantineRoot: path.join(llmwikiRoot, PREPARATION_QUARANTINE_SEGMENT),
    workspaceRoot,
    preparationsRoot,
    runsRoot,
    ...preparationLeaves(preparationsRoot),
    ...runLeaves(runsRoot),
  };
}

/** Return the one project-global preparation-key leaf without a workspace. */
export function preparationKeyFile(root: string): string {
  return path.join(root, ".llmwiki", PREPARATION_KEY_FILENAME);
}

/**
 * The PROJECT-RELATIVE path of one run's advisory cancel leaf.
 *
 * DERIVED from the same layout constructor rather than composed from segments by
 * hand, so a rename cannot leave an operator-facing message naming a path that
 * no longer exists. RELATIVE because no result carries an absolute filesystem
 * path: a refusal naming this leaf is a remedy an operator can act on from the
 * project root, not a disclosure of where the project lives.
 */
export function preparationRelativeCancelPath(workspaceId: string, runId: PreparationRunId): string {
  return preparationPaths("", workspaceId).cancelFile(runId);
}

/** The reserved fixed leaf names beneath one quarantine unit (design section 25.4). */
const QUARANTINE_PLANNED_FILENAME = "quarantine-planned.json";
const QUARANTINE_COMPLETED_FILENAME = "quarantine-completed.json";
const QUARANTINE_RESET_INTENT_FILENAME = "reset-intent.json";
const QUARANTINE_PENDING_RESET_KEY_FILENAME = "pending-reset-key.json";
const QUARANTINE_BYTES_SEGMENT = "bytes";

/** Fixed leaf constructors for one two-phase quarantine unit under the quarantine root. */
export interface QuarantineUnitPaths {
  unitRoot: string;
  plannedReceiptFile: string;
  completedReceiptFile: string;
  resetIntentFile: string;
  pendingResetKeyFile: string;
  bytesRoot: string;
  byteObjectFile(objectName: string): string;
}

/**
 * Whether a value is a portable quarantine-unit / byte-object directory component.
 * Exposed so content parsers can hold ids to the SAME rule the path builder enforces:
 * a parser with its own weaker notion of a safe id is a bypass by construction.
 */
export function isSafeQuarantineComponent(value: unknown): boolean {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_SAFE_COMPONENT_BYTES
    && QUARANTINE_UNIT_ID.test(value) && !WINDOWS_DEVICE_BASENAME.test(value);
}

/**
 * Whether one quarantine storage directory component matches the exact
 * baseline capacity traversal grammar. Regular leaf names are deliberately
 * outside this predicate because baseline capacity counts every opened file.
 */
export function isPortableQuarantineStorageDirectory(value: unknown): boolean {
  return typeof value === "string" && PORTABLE_QUARANTINE_DIRECTORY.test(value);
}

/** Validate one portable quarantine-unit or byte-object directory component. */
function assertQuarantineComponent(value: unknown): string {
  if (!isSafeQuarantineComponent(value)) throw new PreparationIdentityError("safe-component");
  return value as string;
}

/** Fixed leaf constructors for one planned/completed prune or sweep tombstone unit. */
export interface PruneUnitPaths {
  unitRoot: string;
  plannedReceiptFile: string;
  completedReceiptFile: string;
}

/**
 * Build the fixed lexical layout for one prune/sweep tombstone unit. Pruning
 * deletes bytes in place, so the unit holds only its signed planned/completed
 * receipts (the minimal audit tombstone) under a root the inventory scanner does
 * not walk, keeping tombstones out of active and quarantine capacity.
 */
export function preparationPruneUnitPaths(root: string, unitId: string): PruneUnitPaths {
  const unitRoot = path.join(root, ".llmwiki", PREPARATION_PRUNE_SEGMENT, assertQuarantineComponent(unitId));
  return {
    unitRoot,
    plannedReceiptFile: path.join(unitRoot, QUARANTINE_PLANNED_FILENAME),
    completedReceiptFile: path.join(unitRoot, QUARANTINE_COMPLETED_FILENAME),
  };
}

/**
 * Build the fixed lexical layout for one quarantine unit. The unit id and every
 * moved byte-object name are portable directory components validated here before
 * they join a path; the confined no-follow writers re-confine at I/O time.
 */
export function preparationQuarantineUnitPaths(root: string, unitId: string): QuarantineUnitPaths {
  const quarantineRoot = path.join(root, ".llmwiki", PREPARATION_QUARANTINE_SEGMENT);
  const unitRoot = path.join(quarantineRoot, assertQuarantineComponent(unitId));
  const bytesRoot = path.join(unitRoot, QUARANTINE_BYTES_SEGMENT);
  return {
    unitRoot,
    plannedReceiptFile: path.join(unitRoot, QUARANTINE_PLANNED_FILENAME),
    completedReceiptFile: path.join(unitRoot, QUARANTINE_COMPLETED_FILENAME),
    resetIntentFile: path.join(unitRoot, QUARANTINE_RESET_INTENT_FILENAME),
    pendingResetKeyFile: path.join(unitRoot, QUARANTINE_PENDING_RESET_KEY_FILENAME),
    bytesRoot,
    byteObjectFile: (objectName: string) => path.join(bytesRoot, assertQuarantineComponent(objectName)),
  };
}
