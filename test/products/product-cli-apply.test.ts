/**
 * @file test/products/product-cli-apply.test.ts
 * @description `llmwiki product apply` CLOSES the vertical: a real package is
 * installed, activated, invoked to a handoff bundle, and then APPLIED — every
 * step through `dist/cli.js` in a subprocess.
 *
 * THE ASSERTION IS THE PAGE FILE, not the exit code and not the envelope. An
 * apply that returned `status: "applied"` while writing nothing is exactly the
 * failure this verb exists to make impossible, and no status string can witness
 * that. So the suite reads `wiki/wiki-page/action-input.md` off the disk and
 * checks its BYTES hash to the postcondition digest the bundle proposed — the
 * page is not merely present, it is the page that was reviewed.
 *
 * AND IT PINS THE CAUSE. `invoke` alone is asserted to leave the wiki tree empty
 * in the same project, immediately before the apply that fills it, so the write
 * is attributed to `apply` rather than to the pipeline. Delete the apply call
 * and the second half goes red; make `invoke` write and the first half does.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanOperationInventory } from "../../src/operation-bundles/capacity.js";
import { runCLI, expectCLIExit, expectCLIFailure } from "../fixtures/run-cli.js";
import {
  activatedCliProject, invokedBundleDigest, runApply, VERTICAL_ACTION_ID,
} from "./product-cli-fixture.js";

/** Where the vertical fixture's page-create mutation lands, per the page adapter. */
const PAGE_PATH = path.join("wiki", "wiki-page", "action-input.md");

/** Every entry under the project's `wiki/` tree, or none when it does not exist. */
async function wikiEntries(root: string): Promise<string[]> {
  return readdir(path.join(root, "wiki")).catch(() => []);
}

/** The postcondition digest the ONE handed-off bundle proposed for its page. */
async function proposedDigest(root: string): Promise<string> {
  const inventory = await scanOperationInventory(root);
  const mutation = inventory.manifests[0]?.mutations[0];
  if (mutation?.kind !== "page") throw new Error("no page mutation was handed off");
  // Only a delete declares absence; this helper is about a page that was WRITTEN.
  if ("kind" in mutation.postcondition) throw new Error("page mutation declares no bytes");
  return mutation.postcondition.digest;
}

/** The sha256 of the page file as it actually sits on disk. */
async function pageDigestOnDisk(root: string): Promise<string> {
  const bytes = await readFile(path.join(root, PAGE_PATH));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("product apply writes the change through the built binary", () => {
  it("applies an invoked bundle and puts the reviewed page on disk", async () => {
    const project = await activatedCliProject();
    const digest = await invokedBundleDigest(project.root);
    // THE CAUSE, pinned before the effect: the handoff wrote no page.
    expect(await wikiEntries(project.root)).toEqual([]);

    const { result, envelope } = await runApply(digest, project.root);
    expectCLIExit(result, 0);
    expect(envelope.status).toBe("applied");
    expect(envelope.runState).toBe("succeeded");
    expect(envelope.mutations).toEqual({ attempted: 1, applied: 1, skipped: 0, failed: 0 });

    // THE PAGE ITSELF — and the exact page that was reviewed, by digest.
    expect(await pageDigestOnDisk(project.root)).toBe(await proposedDigest(project.root));
    await project.cleanup();
  });

  it("names the operation bundle and run it settled", async () => {
    // The caller pasted a DIGEST and gets back the operation identities, which
    // it could not have known: both were read off the durable manifest.
    const project = await activatedCliProject();
    const digest = await invokedBundleDigest(project.root);
    const { envelope } = await runApply(digest, project.root);
    expect(envelope.bundleId).toMatch(/^bnd_/u);
    expect(envelope.runId).toMatch(/^opr_/u);
    expect(envelope.problems).toEqual([]);
    await project.cleanup();
  });

  it("accepts the BUNDLE id as well as the manifest digest", async () => {
    // Every identifier reaches one bundle by one rule, so an operator reading
    // `operation list` and one reading `invoke` can each paste what they saw.
    const project = await activatedCliProject();
    await invokedBundleDigest(project.root);
    const inventory = await scanOperationInventory(project.root);
    const bundleId = inventory.manifests[0]!.bundleId;
    const { result, envelope } = await runApply(bundleId, project.root);
    expectCLIExit(result, 0);
    expect(envelope.status).toBe("applied");
    expect(envelope.bundleId).toBe(bundleId);
    await project.cleanup();
  });

  it("prints the honest APPLIED line for humans, not just an exit code", async () => {
    const project = await activatedCliProject();
    const digest = await invokedBundleDigest(project.root);
    const result = await runCLI(["product", "apply", digest], project.root);
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("APPLIED");
    expect(result.stdout).toContain("mutations: 1 applied, 0 skipped, 0 failed");
    await project.cleanup();
  });

  it("is idempotent: a second apply neither refuses nor writes again", async () => {
    // The executor answers a wrong-state call with the run's REAL state and no
    // problem, so a settled bundle reports applied again. What must not change is
    // the page: a second write would move its digest.
    const project = await activatedCliProject();
    const digest = await invokedBundleDigest(project.root);
    const first = await runApply(digest, project.root);
    const digestAfterFirst = await pageDigestOnDisk(project.root);

    const second = await runApply(digest, project.root);
    expectCLIExit(second.result, 0);
    expect(second.envelope.runState).toBe(first.envelope.runState);
    expect(second.envelope.mutations).toEqual(first.envelope.mutations);
    expect(await pageDigestOnDisk(project.root)).toBe(digestAfterFirst);
    await project.cleanup();
  });

  it("refuses an unknown target and writes nothing", async () => {
    const project = await activatedCliProject();
    await invokedBundleDigest(project.root);
    const { result, envelope } = await runApply("prr_not-a-real-run", project.root);
    expectCLIFailure(result);
    expect(envelope.status).toBe("refused");
    expect(envelope.reason).toContain("No operation bundle or run matches");
    expect(await wikiEntries(project.root)).toEqual([]);
    await project.cleanup();
  });

  it("refuses in a project that has invoked nothing", async () => {
    // An activated project holding no bundle resolves no target at all, so the
    // refusal comes from the resolver rather than from the executor.
    const project = await activatedCliProject();
    const { result, envelope } = await runApply("prr_anything", project.root);
    expectCLIFailure(result);
    expect(envelope.status).toBe("refused");
    expect(await wikiEntries(project.root)).toEqual([]);
    await project.cleanup();
  });

  it("advertises apply in --help and says it writes", async () => {
    const project = await activatedCliProject();
    const result = await runCLI(["product", "--help"], project.root);
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("apply");
    // `--help` is where an operator decides whether a verb changes their wiki.
    expect(result.stdout).toContain("WRITES the change");
    await project.cleanup();
  });

  it("the invoke handoff line points at the verb that applies it", async () => {
    // THE ANTI-ROT CONTROL. That line previously claimed no command approved a
    // bundle, and `product apply` made it false. Reading it back out of the built
    // CLI is what stops the next such claim from going stale unnoticed.
    const project = await activatedCliProject();
    const result = await runCLI(
      ["product", "invoke", VERTICAL_ACTION_ID, "--input", "topic=x", "--workspace", "research"],
      project.root,
    );
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("llmwiki product apply");
    expect(result.stdout).toContain("NOT APPLIED");
    await project.cleanup();
  });
});
