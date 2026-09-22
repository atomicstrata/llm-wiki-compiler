/**
 * @file test/products/product-cli-refusals.test.ts
 * @description Every way the `product` CLI declines, measured through the built
 * binary.
 *
 * EACH PRODUCT VARIANT PERTURBS EXACTLY ONE PROPERTY of the package the happy
 * path drives, so a refusal here beside a handoff there is evidence the guard
 * reads the property it names rather than refusing everything. The variants are
 * the SHIPPED vertical fixture's — a gated recipe, an undeclared target entity,
 * an entity declared under a directory this surface cannot write — reached
 * through the canonical action id. Their aliases are declared on the `sdk`
 * surface and are simply not used here, which is why these suites can share the
 * in-process fixture rather than restate three packages.
 *
 * THE TWO THROWING VERBS ARE HERE TOO. `install` and `activate` report a bad
 * package or a bad digest by throwing a typed problem; an operator must not be
 * able to tell that from the service's returned refusal, so both are asserted to
 * land as the same closed `{ status: "refused", reason }` envelope with a
 * non-zero exit rather than as an uncaught stack trace.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCLI } from "../fixtures/run-cli.js";
import {
  activatedCliProject, expectRefusalEnvelope, productWorkspace, runAction, VERTICAL_ACTION_ID,
} from "./product-cli-fixture.js";
import {
  buildVerticalProduct, gatedVerticalPack, misplacedEntityProduct, undeclaredTargetVerticalPack,
} from "./product-vertical-fixture.js";
import type { BuiltProductPackage } from "./product-package-fixture.js";

/**
 * Drive BOTH action verbs against one product and return the two reasons.
 *
 * Both, because a refusal that held only on `invoke` would leave `preview`
 * reporting a plan for an action that can never run.
 */
async function refusalReasons(product: BuiltProductPackage): Promise<string[]> {
  const project = await activatedCliProject(product);
  const previewed = await runAction("preview", VERTICAL_ACTION_ID, project.root);
  const invoked = await runAction("invoke", VERTICAL_ACTION_ID, project.root);
  const reasons = [expectRefusalEnvelope(previewed.result), expectRefusalEnvelope(invoked.result)];
  await project.cleanup();
  return reasons;
}

describe("the product CLI refuses an action the active product cannot honor", () => {
  it("DRIVES a gated recipe to its gate and tells the operator how to answer it", async () => {
    // This used to refuse on both verbs: the surface staged a fresh run per call
    // and had no route back from a suspended one. `product resume` is that route,
    // so the CLI now drives to the gate and reports the run as awaiting review —
    // exiting 0, because a run waiting for a person is not a failure. Refusing
    // here would withhold the very review step the gate exists to create.
    const project = await activatedCliProject(buildVerticalProduct(gatedVerticalPack()));
    const invoked = await runAction("invoke", VERTICAL_ACTION_ID, project.root);
    // Exit 0 and the run named: a run waiting for a person is not a failure.
    expect(invoked.result.code, JSON.stringify(invoked.result)).toBe(0);
    const envelope = JSON.parse(invoked.result.stdout) as { status: string; gateIds: string[] };
    expect(envelope.status).toBe("awaiting-review");
    expect(envelope.gateIds).toEqual(["review"]);
    await project.cleanup();
  });

  it("refuses an action targeting an entity type the profile never declares", async () => {
    const product = buildVerticalProduct(undeclaredTargetVerticalPack());
    for (const reason of await refusalReasons(product)) {
      expect(reason).toMatch(/does not declare/u);
    }
  });

  it("refuses an entity declared outside the wiki/<entity-type> directory", async () => {
    // The entity RESOLVES; its create would land outside its own declared
    // storage. Only the profile's `directory` differs from the happy path.
    for (const reason of await refusalReasons(misplacedEntityProduct())) {
      expect(reason).toMatch(/cannot write/u);
    }
  });

  it("refuses a token that names no action or alias on this surface", async () => {
    const project = await activatedCliProject();
    const { result } = await runAction("preview", "no.such.action", project.root);
    expect(expectRefusalEnvelope(result)).toMatch(/unknown-token/u);
    await project.cleanup();
  });
});

describe("the product CLI refuses a bad package or digest", () => {
  it("refuses a source directory that is not a product package", async () => {
    const workspace = await productWorkspace();
    const empty = await mkdtemp(path.join(tmpdir(), "product-cli-empty-"));
    // The closed refusal arm, not an uncaught throw: `install` reports a bad
    // package by THROWING, and an operator must not be able to tell.
    expectRefusalEnvelope(await runCLI(["product", "install", empty, "--json"], workspace.root));
    await rm(empty, { recursive: true, force: true });
    await workspace.cleanup();
  });

  it("refuses a package whose manifest bytes were altered after it was built", async () => {
    const workspace = await productWorkspace();
    await writeFile(path.join(workspace.sourceDir, "manifest.json"), "{ not a manifest");
    const args = ["product", "install", workspace.sourceDir, "--json"];
    expectRefusalEnvelope(await runCLI(args, workspace.root));
    await workspace.cleanup();
  });

  it("refuses a digest that is not a digest, before it can name a stored package", async () => {
    const workspace = await productWorkspace();
    const args = ["product", "activate", "../../etc/passwd", "--json"];
    expect(expectRefusalEnvelope(await runCLI(args, workspace.root))).toMatch(/content digest/u);
    await workspace.cleanup();
  });

  it("refuses a well-formed digest naming no installed package", async () => {
    const workspace = await productWorkspace();
    const args = ["product", "activate", `sha256:${"a".repeat(64)}`, "--json"];
    expectRefusalEnvelope(await runCLI(args, workspace.root));
    await workspace.cleanup();
  });
});

describe("the product CLI refuses malformed action input", () => {
  it("refuses a malformed --input pair with a PARSEABLE envelope", async () => {
    // The workflow group prints and exits on a malformed pair; this group answers
    // in the closed refusal vocabulary, so a `--json` consumer gets an envelope
    // on the path an operator most often mistypes.
    const project = await activatedCliProject();
    const args = ["product", "preview", VERTICAL_ACTION_ID, "--input", "topic", "--json"];
    expect(expectRefusalEnvelope(await runCLI(args, project.root))).toMatch(/key=value/u);
    await project.cleanup();
  });

  it("refuses an --input-json value that is not a scalar or a list of scalars", async () => {
    const project = await activatedCliProject();
    const args = [
      "product", "preview", VERTICAL_ACTION_ID, "--input-json", '{"topic":{"nested":1}}', "--json",
    ];
    expect(expectRefusalEnvelope(await runCLI(args, project.root)))
      .toMatch(/must be a string, number, boolean/u);
    await project.cleanup();
  });
});
