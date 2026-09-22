/**
 * @file test/preparation-cli-sdk-reads.test.ts
 * @description `show` and `preview` on the surfaces an operator and an embedder
 * reach.
 *
 * THE EXIT CODES ARE THE CONTRACT `show` EXISTS TO OFFER. Three outcomes, three
 * codes: a described run is 0, a settled fact about the store is 1, and a fact
 * about this OBSERVER is 2. A script that retries on 2 and reports on 1 is doing
 * the right thing in both cases, and one shared failure code would make that
 * impossible to write — which is why the codes are asserted rather than assumed
 * from the envelope.
 *
 * PREVIEW'S PURITY IS NOT PROVED HERE, and saying so is the point. The manifest
 * counts below establish only that no PREPARATION was created; the operation is
 * accountable for every durable byte, and a count at that level stayed at 1 while
 * `preview` advanced somebody else's run through the mutation gate. The
 * whole-project proof, with a settleable obligation present, lives in
 * `preparation-service-preview-purity.test.ts`. What these cases own is the
 * SURFACE contract: the exit codes, the envelope, and the operator's line.
 */

import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { runCLI, expectCLIJson } from "./fixtures/run-cli.js";
import { createWiki } from "../src/sdk/wiki.js";
import { scanPreparationInventory } from "../src/preparations/capacity.js";
import { emptyWorkspace, initializedWorkspace, planAndSeed } from "./preparation-cli-fixture.js";
import { driveRunning, stageRunIn } from "./preparation-recovery-fixture.js";

/** The exit code reserved for "this observer could not see". */
const UNAVAILABLE_EXIT = 2;

/** Parse one `--json` envelope, failing loudly rather than on a later field. */
function envelope(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("preparation show through the binary", () => {
  it("describes a run and exits 0, reporting the owner's liveness uncollapsed", async () => {
    const cwd = await emptyWorkspace("show-cli-ok");
    const fixture = await stageRunIn(cwd);
    await driveRunning(fixture, "stranded");
    const result = await runCLI(["preparation", "show", fixture.binding.runId, "--json"], cwd);
    expect(result.code, result.stderr).toBe(0);
    const shown = envelope(result.stdout) as { run: { executionOwner: Record<string, unknown> } };
    expect(shown.run.executionOwner).toMatchObject({ liveness: "stale", retryable: false });
  });

  it("puts the operator's next move in the human view, not just the classification", async () => {
    const cwd = await emptyWorkspace("show-cli-human");
    const fixture = await stageRunIn(cwd);
    await driveRunning(fixture, "live");
    const result = await runCLI(["preparation", "show", fixture.binding.runId], cwd);
    expect(result.code, result.stderr).toBe(0);
    // The permanently-undetermined arm. A pid and a label are facts an operator
    // then has to interpret; this is the line that tells them retrying is futile.
    expect(result.stdout).toContain("unobservable-unrecorded");
    expect(result.stdout).toContain("retrying will not change this answer");
  });

  it("exits 1 for a run that does not exist — a settled fact about the store", async () => {
    const cwd = await initializedWorkspace("show-cli-unknown");
    const result = await runCLI(["preparation", "show", "prep-run-nope", "--json"], cwd);
    expect(result.code).toBe(1);
    expect(envelope(result.stdout)).toMatchObject({ status: "refused" });
  });

  it("exits 1, not 2, for a directory that is simply not a project", async () => {
    // NOT-A-PROJECT IS A DENIAL, NOT AN UNAVAILABILITY. Retrying it forever
    // would never help, so it must not land on the retry code.
    const cwd = await emptyWorkspace("show-cli-bare");
    const result = await runCLI(["preparation", "show", "prep-run-nope", "--json"], cwd);
    expect(result.code).toBe(1);
    expect(result.code).not.toBe(UNAVAILABLE_EXIT);
    expect(envelope(result.stdout)).toMatchObject({ status: "refused" });
  });
});

describe("preparation preview through the binary", () => {
  /**
   * A project with a valid plan, its matching seed, and a MINTED KEY.
   *
   * The key is minted by staging once, because preview cannot mint it: the
   * purity primitive parks on a missing key epoch rather than creating one as a
   * side effect. That is the correct trade for purity and a real limit on the
   * verb — pinned by its own case below rather than hidden by this helper.
   */
  async function previewable(suffix: string) {
    const cwd = await initializedWorkspace(suffix);
    const { planFile, seedFile } = await planAndSeed(cwd);
    await runCLI(["preparation", "stage", planFile, "--seed", seedFile, "--json"], cwd);
    return { cwd, planFile, seedFile, staged: 1 };
  }

  it("REFUSES on a project that has never staged, because it will not mint a key", async () => {
    // THE LIMIT, PINNED RATHER THAN WORKED AROUND. Preview reuses the staging
    // transaction on its forced dry-run path, and that path parks on a missing
    // key epoch rather than creating one — minting a durable key would be a
    // project byte written, which is the one thing preview promises not to do.
    // The cost is that preview does not answer on a fresh project, which is
    // where an operator would most want it.
    const cwd = await initializedWorkspace("preview-cli-nokey");
    const { planFile, seedFile } = await planAndSeed(cwd);
    const result = await runCLI(
      ["preparation", "preview", planFile, "--seed", seedFile, "--json"], cwd);
    expectCLIJson(result, 1, {
      status: "refused", reason: "staging refused: preparation-integrity-key-missing",
    });
    // It kept its promise even while refusing: no key, no manifest, nothing.
    expect((await scanPreparationInventory(cwd)).manifests.length).toBe(0);
  });

  it("answers what staging would do and adds NOTHING to the store", async () => {
    const { cwd, planFile, seedFile } = await previewable("preview-cli-ok");
    const result = await runCLI(
      ["preparation", "preview", planFile, "--seed", seedFile, "--json"], cwd);
    expect(result.code, result.stderr).toBe(0);
    // `previewed`, NEVER `staged`. The substrate reports what staging would have
    // produced; the service answers in preview's own vocabulary so the envelope
    // carries no run identity for a run nothing created.
    expect(envelope(result.stdout)).toMatchObject({ status: "previewed", mode: "preview" });
    expect(envelope(result.stdout)).not.toHaveProperty("runId");
    // THE ASSERTION THAT BINDS. The response says what staging would produce;
    // only the inventory says whether it produced it. The count is the ONE run
    // the helper staged to mint the key — preview added nothing to it.
    expect((await scanPreparationInventory(cwd)).manifests.length).toBe(1);
  });

  it("never tells an operator a run was staged", async () => {
    const { cwd, planFile, seedFile } = await previewable("preview-cli-human");
    const result = await runCLI(["preparation", "preview", planFile, "--seed", seedFile], cwd);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("preview only — nothing written");
    // The substrate's own status word must not reach the operator's line: the
    // ids in it would look like handles they could pass to another verb.
    expect(result.stdout).not.toContain("staged prep-run");
  });

  it("refuses a bad plan the same way staging does, still writing nothing", async () => {
    const { cwd, planFile, seedFile } = await previewable("preview-cli-bad");
    await writeFile(planFile, "{ not json", "utf-8");
    const result = await runCLI(
      ["preparation", "preview", planFile, "--seed", seedFile, "--json"], cwd);
    expectCLIJson(result, 1, { status: "refused" });
    expect((await scanPreparationInventory(cwd)).manifests.length).toBe(1);
  });

  it("agrees with stage on the SAME plan — the divergence preview exists to prevent", async () => {
    // Preview routes through the substrate's forced dry-run path, so a check
    // added to staging is a check preview inherits. This is the case that would
    // fail if someone gave preview its own pipeline.
    const { cwd, planFile, seedFile } = await previewable("preview-cli-agrees");
    const previewed = await runCLI(
      ["preparation", "preview", planFile, "--seed", seedFile, "--json"], cwd);
    const staged = await runCLI(
      ["preparation", "stage", planFile, "--seed", seedFile, "--json"], cwd);
    // AGREEMENT IS ABOUT ACCEPTANCE, not about the status word — the two verbs
    // deliberately answer in different vocabularies now, and comparing the words
    // would compare the rename rather than the decision. The exit code is the
    // acceptance both surfaces publish.
    expect(previewed.code, previewed.stderr).toBe(0);
    expect(previewed.code).toBe(staged.code);
    expect(envelope(previewed.stdout).status).toBe("previewed");
    expect(envelope(staged.stdout).status).toBe("staged");
    // And only ONE of the two wrote: the helper's key-minting stage plus this
    // one, never a third from the preview.
    expect((await scanPreparationInventory(cwd)).manifests.length).toBe(2);
  });
});

describe("the read verbs on the SDK surface", () => {
  it("shows a run without any grant at all — `show` is grant-free like `list`", async () => {
    const cwd = await emptyWorkspace("sdk-show-free");
    const fixture = await stageRunIn(cwd);
    const wiki = createWiki({ root: cwd, preparation: { id: "sdk-test", grants: [] } });
    expect(await wiki.showPreparation(fixture.binding.runId)).toMatchObject({ status: "shown" });
  });

  it("previews without any grant at all — `preview` is grant-free too", async () => {
    // §5 ROW 1. This case previously asserted the OPPOSITE, on the argument that
    // an embedder who may not stage should not enumerate staging answers. The
    // exploit that argument was standing in for — a caller-supplied path giving
    // an ungranted client a filesystem oracle — cannot occur here, because the
    // documents arrive as text; and `list`, grant-free beside it, already
    // enumerates every run in the project. The property that replaced the grant
    // is asserted structurally in `preparation-preview-no-caller-path`.
    const cwd = await initializedWorkspace("sdk-preview-nogrant");
    const { planFile, seedFile } = await planAndSeed(cwd);
    // One real stage first, only to mint the key preview will not mint itself.
    await runCLI(["preparation", "stage", planFile, "--seed", seedFile, "--json"], cwd);
    const wiki = createWiki({ root: cwd, preparation: { id: "sdk-test", grants: [] } });
    const outcome = await wiki.previewPreparation({
      planDocument: await readFile(planFile, "utf-8"),
      seedDocument: await readFile(seedFile, "utf-8"),
    });
    expect(outcome).toMatchObject({ status: "previewed" });
    // AND IT STILL WROTE NOTHING. An ungranted caller reaching an operation is
    // only acceptable while that operation stays a read; the purity proof with a
    // settleable obligation present lives in
    // `preparation-service-preview-purity`, over the whole project.
    expect((await scanPreparationInventory(cwd)).manifests.length).toBe(1);
  });
});
