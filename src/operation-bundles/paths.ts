/**
 * @file src/operation-bundles/paths.ts
 * @description Pure lexical construction for every Milestone A operation-store
 * root and leaf. All caller-controlled components are validated before joining;
 * this module performs no filesystem reads, directory creation, or realpath I/O.
 */

import path from "node:path";
import { Buffer } from "node:buffer";
import { isSafeFilenameComponent } from "../profile/identity.js";
import { isWellFormedUnicode } from "../utils/well-formed-unicode.js";
import {
  assertBundleId,
  assertOperationRunId,
  type BundleId,
  type OperationRunId,
} from "./ids.js";
import {
  boundedOperationIdentity,
  exactOperationIdentity,
  OperationIdentityError,
  type OperationIdentityKind,
} from "./problems.js";
import {
  MAX_RECIPE_ID_BYTES,
  MAX_WORKSPACE_ID_BYTES,
} from "./constants.js";

const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;

/**
 * Workspace store directory segment for retained sources. Exported so leaf
 * classification compares against the one authoritative spelling instead of a
 * repeated string literal.
 */
export const SOURCES_SEGMENT = "sources";
const PORTABLE_OPERATION_DIRECTORY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PORTABLE_PROJECTION_COMPONENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const WINDOWS_DEVICE_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const MAX_PROJECTION_OUTPUT_BYTES = 1024;

/** Reserved suffix for host-owned projection provenance markers. */
export const PROJECTION_MARKER_SUFFIX = ".llmwiki-projection.json";

/** Fixed owned roots and validated leaf constructors for one workspace. */
export interface OperationPaths {
  operationKeyFile: string;
  workspacesRoot: string;
  quarantineRoot: string;
  workspaceRoot: string;
  bundlesRoot: string;
  runsRoot: string;
  runEvidenceRoot: string;
  sourcesRoot: string;
  catalogFile: string;
  projectionsRoot: string;
  bundleRoot(bundleId: BundleId): string;
  manifestFile(bundleId: BundleId): string;
  payloadsRoot(bundleId: BundleId): string;
  payloadFile(bundleId: BundleId, digest: string): string;
  runFile(runId: OperationRunId): string;
  cancelFile(runId: OperationRunId): string;
  evidenceRoot(runId: OperationRunId): string;
  evidenceFile(runId: OperationRunId, digest: string): string;
  sourceFile(digest: string): string;
  projectionRoot(recipeId: string): string;
}

/** Layer operation-local type, control, and byte caps over the shared grammar. */
function assertSafeComponent(
  value: unknown,
  kind: OperationIdentityKind,
  maxBytes: number,
): string {
  const component = boundedOperationIdentity(value, kind, maxBytes);
  if (!isSafeFilenameComponent(component) ||
      CONTROL_CHARACTER.test(component) ||
      !isWellFormedUnicode(component) ||
      component.normalize("NFC") !== component ||
      Buffer.byteLength(component, "utf8") > maxBytes) {
    throw new OperationIdentityError(kind);
  }
  return component;
}

/** Require one portable, lowercase physical directory partition key. */
function assertOperationDirectoryId(
  value: unknown,
  kind: OperationIdentityKind,
  maxBytes: number,
): string {
  const component = assertSafeComponent(value, kind, maxBytes);
  if (!PORTABLE_OPERATION_DIRECTORY_ID.test(component)
    || WINDOWS_DEVICE_BASENAME.test(component)) {
    throw new OperationIdentityError(kind);
  }
  return component;
}

/** Validate one workspace id before it enters a path join. */
export function assertWorkspaceId(value: unknown): string {
  return assertOperationDirectoryId(value, "workspace-id", MAX_WORKSPACE_ID_BYTES);
}

/** Require one portable recipe-relative output with marker names reserved. */
export function assertProjectionRelativeOutput(value: unknown): string {
  if (typeof value !== "string" || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_PROJECTION_OUTPUT_BYTES) {
    throw new Error("projection output must be a bounded portable path");
  }
  const segments = value.split("/");
  const invalid = segments.some((segment) =>
    Buffer.byteLength(segment, "utf8") > MAX_RECIPE_ID_BYTES
    || !PORTABLE_PROJECTION_COMPONENT.test(segment)
    || WINDOWS_DEVICE_BASENAME.test(segment)
    || segment.toLowerCase().endsWith(PROJECTION_MARKER_SUFFIX));
  if (invalid) throw new Error("projection output must stay inside its portable recipe root");
  return value;
}

/** Validate one projection recipe id before it enters a path join. */
export function assertRecipeId(value: unknown): string {
  return assertOperationDirectoryId(value, "recipe-id", MAX_RECIPE_ID_BYTES);
}

/** Validate and return one lowercase SHA-256 filename. */
function assertLowercaseSha256(value: unknown): string {
  const digest = exactOperationIdentity(value, "sha256-digest", 64);
  if (!LOWERCASE_SHA256.test(digest)) {
    throw new OperationIdentityError("sha256-digest");
  }
  return digest;
}

/** Build bundle-owned leaf constructors beneath a validated bundles root. */
function bundleLeaves(bundlesRoot: string) {
  const bundleRoot = (bundleId: BundleId) =>
    path.join(bundlesRoot, assertBundleId(bundleId));
  const manifestFile = (bundleId: BundleId) =>
    path.join(bundleRoot(bundleId), "manifest.json");
  const payloadsRoot = (bundleId: BundleId) =>
    path.join(bundleRoot(bundleId), "payloads");
  const payloadFile = (bundleId: BundleId, digest: string) =>
    path.join(payloadsRoot(bundleId), assertLowercaseSha256(digest));
  return { bundleRoot, manifestFile, payloadsRoot, payloadFile };
}

/** Build run-owned leaf constructors beneath validated run roots. */
function runLeaves(runsRoot: string, runEvidenceRoot: string) {
  const runFile = (runId: OperationRunId) =>
    path.join(runsRoot, `${assertOperationRunId(runId)}.json`);
  const cancelFile = (runId: OperationRunId) =>
    path.join(runsRoot, `${assertOperationRunId(runId)}.cancel`);
  const evidenceRoot = (runId: OperationRunId) =>
    path.join(runEvidenceRoot, assertOperationRunId(runId));
  const evidenceFile = (runId: OperationRunId, digest: string) =>
    path.join(evidenceRoot(runId), assertLowercaseSha256(digest));
  return { runFile, cancelFile, evidenceRoot, evidenceFile };
}

/** Return the complete lexical operation-store layout for one workspace. */
export function operationPaths(root: string, workspaceId: string): OperationPaths {
  const llmwikiRoot = path.join(root, ".llmwiki");
  const workspacesRoot = path.join(llmwikiRoot, "workspaces");
  const workspaceRoot = path.join(workspacesRoot, assertWorkspaceId(workspaceId));
  const bundlesRoot = path.join(workspaceRoot, "bundles");
  const runsRoot = path.join(workspaceRoot, "runs");
  const runEvidenceRoot = path.join(workspaceRoot, "run-evidence");
  const sourcesRoot = path.join(workspaceRoot, SOURCES_SEGMENT);
  const projectionsRoot = path.join(workspaceRoot, "projections");
  return {
    operationKeyFile: path.join(llmwikiRoot, "operation-bundles.runkey"),
    workspacesRoot,
    quarantineRoot: path.join(workspacesRoot, ".quarantine"),
    workspaceRoot,
    bundlesRoot,
    runsRoot,
    runEvidenceRoot,
    sourcesRoot,
    catalogFile: path.join(workspaceRoot, "catalog.jsonl"),
    projectionsRoot,
    ...bundleLeaves(bundlesRoot),
    ...runLeaves(runsRoot, runEvidenceRoot),
    sourceFile: (digest) => path.join(sourcesRoot, assertLowercaseSha256(digest)),
    projectionRoot: (recipeId) => path.join(projectionsRoot, assertRecipeId(recipeId)),
  };
}
