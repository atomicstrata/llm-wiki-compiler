/**
 * @file test/products/product-cli.test.ts
 * @description The WOP V3 product vertical is REACHABLE from the built binary:
 * a real package is installed, activated, previewed by both of its names, and
 * driven to a handoff bundle — every step through `dist/cli.js` in a subprocess.
 *
 * A SUBPROCESS IS THE ONLY HONEST TEST OF REACHABILITY. The in-process e2e suite
 * proves the service works and passed for the whole time no public surface could
 * reach it: the vertical shipped with `preview`/`invoke` refusing "no product is
 * active" in every project, because nothing could install or activate one. A
 * suite that imports the registrar would pass even if `cli.ts` never called it;
 * these tests either reach the command through commander's registration or they
 * do not.
 *
 * THE HANDOFF ASSERTION IS ON THE HONEST LINE, not only on the exit code. The
 * one thing this surface must never do is let an operator believe their wiki
 * changed — so the success path is asserted to SAY it applied nothing, and the
 * project is read afterwards to confirm it wrote no page.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCLI, expectCLIExit, expectCLIFailure } from "../fixtures/run-cli.js";
import {
  activatedCliProject, actionEnvelope, productWorkspace, runAction,
  CLI_ALIAS_TOKEN, VERTICAL_ACTION_ID,
} from "./product-cli-fixture.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

/** Every entry under the project's `wiki/` tree, or none when it does not exist. */
async function wikiEntries(root: string): Promise<string[]> {
  return readdir(path.join(root, "wiki")).catch(() => []);
}

describe("the product CLI is reachable from the built binary", () => {
  it("advertises the group in --help", async () => {
    const workspace = await productWorkspace();
    const result = await runCLI(["--help"], workspace.root);
    expectCLIExit(result, 0);
    // Registration observed through the real program: an import-based check
    // would pass even if `cli.ts` never called the registrar.
    expect(result.stdout).toContain("product");
    await workspace.cleanup();
  });

  it("installs a real package and reports its digest without activating it", async () => {
    const workspace = await productWorkspace();
    const result = await runCLI(["product", "install", workspace.sourceDir, "--json"], workspace.root);
    expectCLIExit(result, 0);
    const envelope = JSON.parse(result.stdout) as { status: string; packageDigest: string };
    expect(envelope.status).toBe("installed");
    expect(envelope.packageDigest).toBe(workspace.packageDigest);
    await workspace.cleanup();
  });

  it("an INSTALLED package governs nothing until it is activated", async () => {
    // THE PROPERTY THE INSTALLER IS BUILT ON: it writes inert bytes and never
    // writes `active-product.json`. A CLI that collapsed the two verbs, or an
    // install that activated as a side effect, goes red here.
    const workspace = await productWorkspace();
    expectCLIExit(await runCLI(["product", "install", workspace.sourceDir], workspace.root), 0);
    const { result, envelope } = await runAction("preview", VERTICAL_ACTION_ID, workspace.root);
    expectCLIFailure(result);
    expect(envelope.status).toBe("refused");
    expect(envelope.reason).toMatch(/no product is active/u);
    await workspace.cleanup();
  });

  it("activates one installed package by exact digest", async () => {
    const workspace = await productWorkspace();
    expectCLIExit(await runCLI(["product", "install", workspace.sourceDir], workspace.root), 0);
    const result = await runCLI(["product", "activate", workspace.packageDigest, "--json"], workspace.root);
    expectCLIExit(result, 0);
    const envelope = JSON.parse(result.stdout) as { status: string; packageDigest: string };
    expect(envelope.status).toBe("activated");
    expect(envelope.packageDigest).toBe(workspace.packageDigest);
    await workspace.cleanup();
  });
});

describe("product preview compiles the same plan through both names", () => {
  it("reports an identical plan digest for the action id and its alias", async () => {
    // WOP-INV-21, asserted from a SHELL. The plan digest covers the whole
    // normalized plan, so two invocations agreeing on it agree on everything the
    // run is sealed against. Mutation witness: point the alias at a second
    // declared action, or move its transport surface, and this equality goes red.
    const project = await activatedCliProject();
    const direct = await runAction("preview", VERTICAL_ACTION_ID, project.root);
    const alias = await runAction("preview", CLI_ALIAS_TOKEN, project.root);
    expect(alias.envelope.status).toBe(direct.envelope.status);
    expect(alias.envelope.action?.planDigest).toBe(direct.envelope.action?.planDigest);
    expect(direct.envelope.action?.planDigest).toMatch(DIGEST);
    await project.cleanup();
  });

  it("resolves the alias to the canonical action on the CLI surface", async () => {
    const project = await activatedCliProject();
    const { envelope } = await runAction("preview", CLI_ALIAS_TOKEN, project.root);
    expect(envelope.action?.actionId).toBe(VERTICAL_ACTION_ID);
    expect(envelope.action?.route).toBe("alias");
    // The surface is the CALLER's, never the alias's — and from a shell it is
    // always `cli`, because no flag can present one.
    expect(envelope.action?.requestedSurface).toBe("cli");
    await project.cleanup();
  });

  it("reports the compiled summary even when the dry run declines", async () => {
    // A project that has never staged a preparation has no integrity key to bind
    // a manifest to, so the substrate's dry run declines — and the third arm
    // still carries the digest an alias-parity check needs. Exiting non-zero is
    // the honest half: nothing answered "yes, this would work".
    const project = await activatedCliProject();
    const { result, envelope } = await runAction("preview", VERTICAL_ACTION_ID, project.root);
    expectCLIFailure(result);
    expect(envelope.status).toBe("preview-refused");
    expect(envelope.action?.planDigest).toMatch(DIGEST);
    expect(envelope.reason).toEqual(expect.any(String));
    await project.cleanup();
  });

  it("previews as a true dry run once the project holds an integrity key", async () => {
    const project = await activatedCliProject();
    const invoked = await runAction("invoke", VERTICAL_ACTION_ID, project.root);
    expect(invoked.envelope.status).toBe("handed-off");
    const { result, envelope } = await runAction("preview", VERTICAL_ACTION_ID, project.root);
    expectCLIExit(result, 0);
    expect(envelope.status).toBe("previewed");
    await project.cleanup();
  });
});

describe("product invoke drives one action to a handoff it does not apply", () => {
  it("hands off a bundle and reports the run and manifest digest", async () => {
    const project = await activatedCliProject();
    const { result, envelope } = await runAction("invoke", VERTICAL_ACTION_ID, project.root);
    expectCLIExit(result, 0);
    expect(envelope.status).toBe("handed-off");
    expect(envelope.runId).toEqual(expect.any(String));
    expect(envelope.bundleManifestDigest).toMatch(DIGEST);
    expect(envelope.action?.actionId).toBe(VERTICAL_ACTION_ID);
    await project.cleanup();
  });

  it("SAYS on the success path that it applied nothing", async () => {
    // THE ONE THING THIS SURFACE MUST NEVER DO is let an operator read a run id
    // and a digest as "it was created". Delete the notice from `action.ts` and
    // this goes red while every status assertion above stays green.
    const project = await activatedCliProject();
    const result = await runCLI(
      ["product", "invoke", VERTICAL_ACTION_ID, "--input", "topic=superconductivity"], project.root);
    expectCLIExit(result, 0);
    expect(result.stdout).toMatch(/NOT APPLIED/u);
    expect(result.stdout).toMatch(/Nothing was written to your wiki/u);
    expect(result.stdout).toMatch(/separate operation/u);
    await project.cleanup();
  });

  it("points at the review command AND at the verb that applies the bundle", async () => {
    // MEASURED, because this half is the part that rots — and it DID. The line
    // used to end "no command approves or applies it yet", which was true until
    // `product apply` shipped; this assertion is what made the stale sentence
    // fail rather than quietly mislead, and it now pins the replacement. Both
    // halves are asserted: a pointer to review without a pointer to apply strands
    // an operator, and the reverse invites applying what nobody read.
    const project = await activatedCliProject();
    const invoked = await runCLI(
      ["product", "invoke", VERTICAL_ACTION_ID, "--input", "topic=x"], project.root);
    expectCLIExit(invoked, 0);
    expect(invoked.stdout).toMatch(/llmwiki operation inspect/u);
    expect(invoked.stdout).toMatch(/llmwiki product apply/u);
    expect(invoked.stdout).toMatch(/operation-bundle\.approve/u);

    // The proposal really IS listed there, awaiting approval.
    const listed = await runCLI(["operation", "list"], project.root);
    expectCLIExit(listed, 0);
    expect(listed.stdout).toMatch(/awaiting-approval/u);
    await project.cleanup();
  });

  it("writes NO wiki page — the bundle proposes the create, it does not perform it", async () => {
    // The claim above, measured against the project rather than against the
    // wording. A surface that applied its own bundle would leave a page here.
    const project = await activatedCliProject();
    expect(await wikiEntries(project.root)).toEqual([]);
    const { envelope } = await runAction("invoke", VERTICAL_ACTION_ID, project.root);
    expect(envelope.status).toBe("handed-off");
    expect(await wikiEntries(project.root)).toEqual([]);
    await project.cleanup();
  });

  it("hands off the same plan whether the caller named the action or the alias", async () => {
    const project = await activatedCliProject();
    const direct = await runAction("invoke", VERTICAL_ACTION_ID, project.root);
    const alias = await runAction("invoke", CLI_ALIAS_TOKEN, project.root);
    expect(direct.envelope.status).toBe("handed-off");
    expect(alias.envelope.status).toBe("handed-off");
    expect(alias.envelope.action?.planDigest).toBe(direct.envelope.action?.planDigest);
    // Two runs of ONE plan: the alias drove the identical certified preparation.
    expect(alias.envelope.runId).not.toBe(direct.envelope.runId);
    await project.cleanup();
  });

  it("emits a parseable envelope on the refusal path too", async () => {
    const workspace = await productWorkspace();
    const result = await runCLI(["product", "invoke", VERTICAL_ACTION_ID, "--json"], workspace.root);
    expectCLIFailure(result);
    expect(actionEnvelope(result).status).toBe("refused");
    await workspace.cleanup();
  });
});
