/**
 * @file test/products/product-cli-fixture.ts
 * @description The temp project, the on-disk package source, and the two
 * envelope readers the `product` CLI subprocess suites share.
 *
 * THE PACK IS THE VERTICAL'S, with ONE property changed: its alias is declared
 * on the `cli` surface instead of `sdk`. An alias only resolves when its own
 * transport is the surface the caller invoked on, so the shipped vertical
 * fixture's `sdk` alias is unreachable from a shell — and a CLI alias-parity
 * assertion built on it would be asserting that two refusals match. Everything
 * else is `verticalPack()`'s, so the package these suites drive is the package
 * the activator would accept from a publisher.
 *
 * NOTHING HERE INSTALLS IN PROCESS. The whole point of a subprocess suite is
 * that the command is reached through commander's registration or not at all,
 * so install and activation are performed BY THE TESTS through `runCLI`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import type { WorkspaceOperationsPackV2 } from "../../src/operations-packs/types.js";
import { runCLI, expectCLIExit, expectCLIFailure, type CLIResult } from "../fixtures/run-cli.js";
import { writeSourcePackage, type BuiltProductPackage } from "./product-package-fixture.js";
import { buildVerticalProduct, verticalPack, VERTICAL_ACTION_ID } from "./product-vertical-fixture.js";

export { VERTICAL_ACTION_ID } from "./product-vertical-fixture.js";

/** The alias token that reaches {@link VERTICAL_ACTION_ID} on the CLI surface. */
export const CLI_ALIAS_TOKEN = "draft";

/** The workspace these suites record every run under. */
const CLI_WORKSPACE_ID = "research";

/** The vertical's pack with its alias moved to the CLI surface. */
function cliVerticalPack(): WorkspaceOperationsPackV2 {
  return verticalPack((pack) => {
    pack.aliases = [
      { aliasId: "draft-alias", surface: "cli", token: CLI_ALIAS_TOKEN, actionId: VERTICAL_ACTION_ID },
    ];
  });
}

/** The complete product package whose action a shell can reach both ways. */
function cliVerticalProduct(): BuiltProductPackage {
  return buildVerticalProduct(cliVerticalPack());
}

/** A fresh project root beside the package source directory the CLI installs from. */
export interface ProductWorkspaceV1 {
  readonly root: string;
  readonly sourceDir: string;
  readonly packageDigest: string;
  cleanup(): Promise<void>;
}

/** Write one built product to a source directory beside a fresh project root. */
export async function productWorkspace(
  product: BuiltProductPackage = cliVerticalProduct(),
): Promise<ProductWorkspaceV1> {
  const root = await mkdtemp(path.join(tmpdir(), "product-cli-"));
  const sourceDir = await mkdtemp(path.join(tmpdir(), "product-cli-src-"));
  await writeSourcePackage(sourceDir, product);
  return {
    root, sourceDir, packageDigest: product.manifest.packageDigest,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    },
  };
}

/** Install and activate one workspace's package through the built binary. */
async function activatedThroughCli(
  workspace: ProductWorkspaceV1,
): Promise<ProductWorkspaceV1> {
  expectCLIExit(await runCLI(["product", "install", workspace.sourceDir], workspace.root), 0);
  expectCLIExit(await runCLI(["product", "activate", workspace.packageDigest], workspace.root), 0);
  return workspace;
}

/** A project with the CLI-alias vertical product installed and activated. */
export async function activatedCliProject(
  product: BuiltProductPackage = cliVerticalProduct(),
): Promise<ProductWorkspaceV1> {
  return activatedThroughCli(await productWorkspace(product));
}

/** The `--input`/`--workspace` flags every action invocation in these suites uses. */
const ACTION_FLAGS = [
  "--input", "topic=superconductivity", "--workspace", CLI_WORKSPACE_ID, "--json",
] as const;

/** The compile-time facts an action verb's envelope reports. */
export interface ActionEnvelopeV1 {
  status: string;
  reason?: string;
  runId?: string;
  bundleManifestDigest?: string;
  action?: { actionId: string; planDigest: string; route: string; requestedSurface: string };
}

/**
 * Parse one action verb's envelope.
 *
 * PARSED, NEVER STRING-MATCHED: the contract is that a machine consumer can read
 * this, and a human line containing the word "refused" would satisfy a substring
 * check while breaking every actual consumer.
 */
export function actionEnvelope(result: CLIResult): ActionEnvelopeV1 {
  expect(result.stdout, `stdout was not an envelope:\n${result.stderr}`).not.toBe("");
  return JSON.parse(result.stdout) as ActionEnvelopeV1;
}

/** Run one action verb with the shared flags and return its parsed envelope. */
export async function runAction(
  verb: "preview" | "invoke", token: string, root: string,
): Promise<{ result: CLIResult; envelope: ActionEnvelopeV1 }> {
  const result = await runCLI(["product", verb, token, ...ACTION_FLAGS], root);
  return { result, envelope: actionEnvelope(result) };
}

/** What `product apply` reports: the arm, the identities, and the run's counters. */
export interface ApplyEnvelopeV1 {
  status: string;
  reason?: string;
  bundleId?: string;
  runId?: string;
  runState?: string;
  mutations?: { attempted: number; applied: number; skipped: number; failed: number };
  problems?: { code: string; message: string }[];
}

/** Run `product apply` on one bundle or run id and return its parsed envelope. */
export async function runApply(
  bundle: string, root: string,
): Promise<{ result: CLIResult; envelope: ApplyEnvelopeV1 }> {
  const result = await runCLI(["product", "apply", bundle, "--json"], root);
  expect(result.stdout, `stdout was not an envelope:\n${result.stderr}`).not.toBe("");
  return { result, envelope: JSON.parse(result.stdout) as ApplyEnvelopeV1 };
}

/**
 * Drive one activated project to a handoff and return the identifier `apply`
 * takes: the bundle MANIFEST DIGEST.
 *
 * The digest deliberately, because it is what `invoke` prints. Its other
 * identifier, `runId`, is the PREPARATION run id — a different identity space
 * from the operation run the bundle belongs to — so the digest is the only value
 * on that output an operator can paste into `apply`. Returning it here is what
 * makes these suites test the real paste-through path.
 */
export async function invokedBundleDigest(root: string): Promise<string> {
  const { result, envelope } = await runAction("invoke", VERTICAL_ACTION_ID, root);
  expectCLIExit(result, 0);
  expect(envelope.status).toBe("handed-off");
  expect(envelope.bundleManifestDigest).toBeDefined();
  return envelope.bundleManifestDigest as string;
}

/**
 * Assert one invocation refused with a PARSEABLE envelope, and return its reason.
 *
 * Sharing the trio keeps the important half — the REASON — impossible to forget,
 * which is the half that is missing when a suite passes under a mutation that
 * refuses every invocation.
 */
export function expectRefusalEnvelope(result: CLIResult): string {
  expectCLIFailure(result);
  const envelope = actionEnvelope(result);
  expect(envelope.status).toBe("refused");
  return envelope.reason ?? "";
}
