/**
 * @file test/operation-bundles/identity-paths.test.ts
 * @description Pins the Milestone A identity domains, launch caps, and lexical
 * operation-store layout. These tests deliberately exercise path construction
 * without creating a project tree so reads and writes cannot hide in helpers.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_ACTIVE_BUNDLE_BYTES,
  MAX_BUNDLE_PAYLOAD_BYTES,
  MAX_CATALOG_FILE_BYTES,
  MAX_CATALOG_RECORD_BYTES,
  MAX_CATALOG_RECORDS_PER_WORKSPACE,
  MAX_MANIFEST_BYTES,
  MAX_MUTATIONS_PER_BUNDLE,
  MAX_NEW_BUNDLES_PER_STAGING_CALL,
  MAX_PAYLOAD_BYTES,
  MAX_PENDING_BUNDLES,
  MAX_PROJECTION_BYTES,
  MAX_RECIPE_ID_BYTES,
  MAX_RETAINED_SOURCE_BYTES,
  MAX_RUN_BYTES,
  MAX_RUN_EVIDENCE_BLOB_BYTES,
  MAX_RUN_EVIDENCE_BYTES,
  MAX_RUN_TRANSITIONS,
  MAX_TRANSITION_ENVELOPE_BYTES,
  MAX_WORKSPACE_PROJECTION_BYTES,
  MAX_WORKSPACE_ID_BYTES,
  MAX_WORKSPACE_RETAINED_SOURCE_BYTES,
  RUN_CONTROL_RESERVE_BYTES,
} from "../../src/operation-bundles/constants.js";
import {
  assertBundleId,
  assertCatalogRecordId,
  assertOperationRunId,
  catalogRecordId,
  compensationId,
  mintBundleId,
  mintOperationRunId,
  mutationId,
  type BundleId,
  type OperationRunId,
} from "../../src/operation-bundles/ids.js";
import {
  assertProjectionRelativeOutput,
  assertWorkspaceId,
  operationPaths,
} from "../../src/operation-bundles/paths.js";
import {
  OPERATION_GRANTS,
  OPERATION_PRINCIPAL_SURFACES,
  type OperationPrincipal,
} from "../../src/operation-bundles/principal.js";
import {
  OperationIdentityError,
  OPERATION_PROBLEM_CODES,
  type OperationProblem,
} from "../../src/operation-bundles/problems.js";
import { isSafeFilenameComponent } from "../../src/profile/identity.js";
import { WINDOWS_RESERVED_DEVICE_NAMES } from "./windows-reserved-names.js";

const BUNDLE_ID = "bnd_01J00000000000000000000000" as BundleId;
const RUN_ID = "opr_01J00000000000000000000000" as OperationRunId;
const SHA256 = "a".repeat(64);
const IDENTITY_ERROR_MESSAGE_LIMIT = 512;
const EXPECTED_SURFACES = ["cli", "sdk", "mcp"];
const EXPECTED_GRANTS = [
  "operation-bundle.prepare",
  "operation-bundle.approve", "operation-bundle.reject", "operation-bundle.revise",
  "operation-bundle.cancel", "operation-bundle.abandon", "operation-bundle.quarantine",
  "operation-bundle.quarantine-purge",
];
const EXPECTED_PROBLEM_CODES = [
  "review-item-not-found", "review-store-unavailable", "review-item-invalid",
  "review-id-ambiguous", "review-list-incomplete", "review-digest-mismatch",
  "approval-grant-missing", "approval-invalidated", "bundle-capacity-exceeded",
  "bundle-precondition-conflict", "bundle-preconditions-stale", "bundle-recovery-required",
  "bundle-orphaned", "bundle-recovery-blocking", "run-record-headroom-exhausted",
  "run-integrity-invalid", "integrity-key-missing", "integrity-key-unreadable",
  "quarantine-pending", "quarantine-retained", "residual-state-abandoned",
  "concurrent-change",
];
const WINDOWS_DEVICE_BASENAMES = WINDOWS_RESERVED_DEVICE_NAMES;

/** Assert one action fails through the bounded typed identity boundary. */
function expectBoundedIdentityError(action: () => unknown): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OperationIdentityError);
  if (caught instanceof Error) {
    expect(caught.message.length).toBeLessThanOrEqual(IDENTITY_ERROR_MESSAGE_LIMIT);
  }
}

/** Pin portable lowercase values immediately around the 128-byte cap. */
function expectPortableByteBoundary(assertIdentity: (value: string) => unknown): void {
  for (const value of ["a".repeat(127), "a".repeat(128)]) {
    expect(() => assertIdentity(value)).not.toThrow();
  }
  expectBoundedIdentityError(() => assertIdentity("a".repeat(129)));
}

describe("operation bundle identities", () => {
  it("mints bundle and run ids in their strict namespaces", () => {
    expect(mintBundleId()).toMatch(/^bnd_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(mintOperationRunId()).toMatch(/^opr_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it("accepts the complete canonical ULID suffix range", () => {
    expect(assertBundleId(`bnd_7${"Z".repeat(25)}`)).toBe(`bnd_7${"Z".repeat(25)}`);
    expect(assertOperationRunId(`opr_0${"0".repeat(25)}`)).toBe(`opr_0${"0".repeat(25)}`);
  });

  it.each([
    `8${"0".repeat(25)}`, `Z${"0".repeat(25)}`, `0${"a".repeat(25)}`,
    ...["I", "L", "O", "U"].map((character) => `0${character}${"0".repeat(24)}`),
    "0".repeat(25), "0".repeat(27),
  ])("rejects non-canonical ULID suffix %s", (suffix) => {
    expectBoundedIdentityError(() => assertBundleId(`bnd_${suffix}`));
    expectBoundedIdentityError(() => assertOperationRunId(`opr_${suffix}`));
  });

  it("derives exact domain-separated mutation and compensation ids", () => {
    const first = mutationId(BUNDLE_ID, 0);
    const second = mutationId(BUNDLE_ID, 1);

    expect(first).toBe("opm_dde4d6fe11589f741d377ccdda04f0552d7f6c56449567bdd6b4e579d05c28b2");
    expect(second).toBe("opm_6532fcc0494a755ce0ee51eafdad987551bc705f98962acc1dc610269445bdb5");
    expect(compensationId(first)).toBe("opc_67352d4b9a8b96b397e69ca398e5a08b655f18ceddfc567a38ddb1e319ac3ac0");
  });

  it("derives and validates the shared catalog physical-record identity", () => {
    const recordId = catalogRecordId(mutationId(BUNDLE_ID, 0));
    expect(recordId).toBe("cat_606576b31e846fd14f74c69320cb4ec41347b2f9321c2435bb21fa5304329181");
    expect(assertCatalogRecordId(recordId)).toBe(recordId);
    expectBoundedIdentityError(() => assertCatalogRecordId("cat-prior"));
  });

  it("accepts the last launch mutation index", () => {
    expect(mutationId(BUNDLE_ID, 255)).toMatch(/^opm_[0-9a-f]{64}$/);
  });

  it.each([256, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid mutation index %s",
    (index) => expectBoundedIdentityError(() => mutationId(BUNDLE_ID, index)),
  );

  it.each([
    ["null", null], ["number", 123], ["array", []], ["plain object", {}],
  ])("rejects non-string %s identities", (_label, value) => {
    for (const assertion of [assertBundleId, assertOperationRunId, assertWorkspaceId]) {
      expectBoundedIdentityError(() => assertion(value));
    }
  });

  it("does not invoke hostile object coercion hooks", () => {
    const hostile = {
      toJSON: () => { throw new Error("toJSON invoked"); },
      toString: () => { throw new Error("toString invoked"); },
      [Symbol.toPrimitive]: () => { throw new Error("coercion invoked"); },
    };
    const paths = operationPaths("/project", "workspace-a");

    for (const assertion of [assertBundleId, assertOperationRunId, assertWorkspaceId]) {
      expectBoundedIdentityError(() => assertion(hostile));
    }
    expectBoundedIdentityError(() => paths.projectionRoot(hostile as unknown as string));
  });

  it("rejects a revoked proxy through the typed identity boundary", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    const paths = operationPaths("/project", "workspace-a");
    revoke();

    for (const assertion of [assertBundleId, assertOperationRunId, assertWorkspaceId]) {
      expectBoundedIdentityError(() => assertion(proxy));
    }
    expectBoundedIdentityError(() => paths.projectionRoot(proxy as unknown as string));
  });

  it("bounds error messages for oversized hostile strings", () => {
    const oversized = `.${"x".repeat(10_000)}`;
    const paths = operationPaths("/project", "workspace-a");

    expectBoundedIdentityError(() => assertBundleId(oversized));
    expectBoundedIdentityError(() => assertOperationRunId(oversized));
    expectBoundedIdentityError(() => assertWorkspaceId(oversized));
    expectBoundedIdentityError(() => paths.projectionRoot(oversized));
  });
});

describe("operation bundle launch caps", () => {
  it("exports every V2 launch cap in its declared unit", () => {
    expect([
      MAX_NEW_BUNDLES_PER_STAGING_CALL, MAX_PENDING_BUNDLES, MAX_MUTATIONS_PER_BUNDLE,
      MAX_PAYLOAD_BYTES, MAX_BUNDLE_PAYLOAD_BYTES, MAX_MANIFEST_BYTES, MAX_RUN_BYTES,
      MAX_TRANSITION_ENVELOPE_BYTES, MAX_RUN_TRANSITIONS, RUN_CONTROL_RESERVE_BYTES,
      MAX_RUN_EVIDENCE_BLOB_BYTES, MAX_RUN_EVIDENCE_BYTES, MAX_ACTIVE_BUNDLE_BYTES,
      MAX_RETAINED_SOURCE_BYTES, MAX_WORKSPACE_RETAINED_SOURCE_BYTES, MAX_CATALOG_RECORD_BYTES,
      MAX_CATALOG_RECORDS_PER_WORKSPACE, MAX_CATALOG_FILE_BYTES, MAX_PROJECTION_BYTES,
      MAX_WORKSPACE_PROJECTION_BYTES,
    ]).toEqual([
      10, 50, 256, 16 * 1024 ** 2, 64 * 1024 ** 2, 4 * 1024 ** 2, 4 * 1024 ** 2,
      2 * 1024, 1_100, 128 * 1024, 256 * 1024, 16 * 1024 ** 2, 512 * 1024 ** 2,
      16 * 1024 ** 2, 512 * 1024 ** 2, 64 * 1024, 50_000, 32 * 1024 ** 2,
      16 * 1024 ** 2, 256 * 1024 ** 2,
    ]);
  });

  it("exports the D-012 operation identity byte caps", () => {
    expect(MAX_WORKSPACE_ID_BYTES).toBe(128);
    expect(MAX_RECIPE_ID_BYTES).toBe(128);
  });

  it("pins immutable principal surfaces and grants", () => {
    const principal: OperationPrincipal = { id: "operator", surface: "cli", grants: OPERATION_GRANTS };

    expect(OPERATION_PRINCIPAL_SURFACES).toEqual(EXPECTED_SURFACES);
    expect(Object.isFrozen(OPERATION_PRINCIPAL_SURFACES)).toBe(true);
    expect(principal.grants).toEqual(EXPECTED_GRANTS);
    expect(Object.isFrozen(OPERATION_GRANTS)).toBe(true);
  });

  it("pins the immutable operation problem vocabulary", () => {
    const problem: OperationProblem = { code: "review-item-invalid", message: "invalid" };

    expect(OPERATION_PROBLEM_CODES).toEqual(EXPECTED_PROBLEM_CODES);
    expect(Object.isFrozen(OPERATION_PROBLEM_CODES)).toBe(true);
    expect(problem).toEqual({ code: "review-item-invalid", message: "invalid" });
  });
});

describe("operation bundle lexical paths", () => {
  it.each([".quarantine", "../x", "a/b", "", ".hidden", "a\\b"])(
    "rejects unsafe workspace id %s",
    (workspaceId) => expect(() => assertWorkspaceId(workspaceId)).toThrow(),
  );

  it("applies the inclusive portable byte cap to workspace and recipe ids", () => {
    expectPortableByteBoundary(assertWorkspaceId);
    const paths = operationPaths("/project", "workspace-a");
    expectPortableByteBoundary((value) => paths.projectionRoot(value));
  });

  it.each(WINDOWS_DEVICE_BASENAMES)("rejects Windows device output basename %s", (basename) => {
    expect(() => assertProjectionRelativeOutput(`nested/${basename}.md`)).toThrow(/output|portable/i);
  });

  it.each(WINDOWS_DEVICE_BASENAMES)("rejects Windows device directory id %s", (basename) => {
    expect(() => operationPaths("/project", basename)).toThrow();
    expect(() => operationPaths("/project", "workspace-a").projectionRoot(basename)).toThrow();
  });

  it.each(["\0", "\u0001", "\t", "\n", "\r", "\u001f", "\u007f", "/", "\\"])(
    "rejects operation-local control or separator %j",
    (character) => {
      const paths = operationPaths("/project", "workspace-a");
      expectBoundedIdentityError(() => assertWorkspaceId(`work${character}space`));
      expectBoundedIdentityError(() => paths.projectionRoot(`rec${character}ipe`));
    },
  );

  it.each([
    ["uppercase", "Workspace-a"],
    ["underscore", "workspace_a"],
    ["leading hyphen", "-workspace"],
    ["trailing hyphen", "workspace-"],
    ["repeated hyphen", "work--space"],
    ["lowercase Unicode", "work-é"],
    ["Unicode case-fold alias", "work-K"],
    ["lone high surrogate", "work-\ud800"],
    ["lone low surrogate", "work-\udc00"],
    ["non-NFC text", "work-e\u0301"],
  ])("rejects %s operation directory keys", (_label, value) => {
    const paths = operationPaths("/project", "workspace-a");
    expectBoundedIdentityError(() => assertWorkspaceId(value));
    expectBoundedIdentityError(() => paths.projectionRoot(value));
  });

  it("does not narrow the shared legacy filename validator", () => {
    expect(isSafeFilenameComponent("legacy\nslug")).toBe(true);
    expect(isSafeFilenameComponent("legacy\tslug")).toBe(true);
  });

  it("returns the exact V2 owned roots", () => {
    const root = path.join(path.sep, "project");
    const paths = operationPaths(root, "workspace-a");
    const workspaceRoot = path.join(root, ".llmwiki", "workspaces", "workspace-a");

    expect(paths).toMatchObject({
      operationKeyFile: path.join(root, ".llmwiki", "operation-bundles.runkey"),
      workspacesRoot: path.join(root, ".llmwiki", "workspaces"),
      quarantineRoot: path.join(root, ".llmwiki", "workspaces", ".quarantine"),
      workspaceRoot,
      bundlesRoot: path.join(workspaceRoot, "bundles"),
      runsRoot: path.join(workspaceRoot, "runs"),
      runEvidenceRoot: path.join(workspaceRoot, "run-evidence"),
      sourcesRoot: path.join(workspaceRoot, "sources"),
      catalogFile: path.join(workspaceRoot, "catalog.jsonl"),
      projectionsRoot: path.join(workspaceRoot, "projections"),
    });
  });

  it("validates components before returning lowercase digest leaves", () => {
    const paths = operationPaths("/project", "workspace-a");
    const bundleRoot = path.join(paths.bundlesRoot, BUNDLE_ID);
    const evidenceRoot = path.join(paths.runEvidenceRoot, RUN_ID);

    expect(paths.bundleRoot(BUNDLE_ID)).toBe(bundleRoot);
    expect(paths.manifestFile(BUNDLE_ID)).toBe(path.join(bundleRoot, "manifest.json"));
    expect(paths.payloadsRoot(BUNDLE_ID)).toBe(path.join(bundleRoot, "payloads"));
    expect(paths.payloadFile(BUNDLE_ID, SHA256)).toBe(
      path.join(bundleRoot, "payloads", SHA256),
    );
    expect(paths.runFile(RUN_ID)).toBe(path.join(paths.runsRoot, `${RUN_ID}.json`));
    expect(paths.cancelFile(RUN_ID)).toBe(path.join(paths.runsRoot, `${RUN_ID}.cancel`));
    expect(paths.evidenceRoot(RUN_ID)).toBe(evidenceRoot);
    expect(paths.evidenceFile(RUN_ID, SHA256)).toBe(path.join(evidenceRoot, SHA256));
    expect(paths.sourceFile(SHA256)).toBe(path.join(paths.sourcesRoot, SHA256));
    expect(paths.projectionRoot("recipe-a")).toBe(path.join(paths.projectionsRoot, "recipe-a"));
    expect(() => paths.payloadFile("bnd_../escape" as BundleId, SHA256)).toThrow();
    expect(() => paths.runFile(BUNDLE_ID as unknown as OperationRunId)).toThrow();
    expect(() => paths.sourceFile(SHA256.toUpperCase())).toThrow();
    expect(() => paths.projectionRoot(".hidden")).toThrow();
  });
});
