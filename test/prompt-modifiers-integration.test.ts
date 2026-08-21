/**
 * @file test/prompt-modifiers-integration.test.ts
 * @description Flipping a prompt modifier on an ALREADY-COMPILED project
 * regenerates its pages, end to end through the CLI.
 *
 * This is the behaviour the unit tests cannot reach. `detectChanges` classifies
 * a source by the SHA-256 of its bytes, so a second `compile` over unchanged
 * sourcesshort-circuits at "Nothing to compile" before any prompt is built — and a
 * newly-set `--lang` silently did nothing. The control that matters is a
 * SECOND compile whose sources are byte-identical to the first.
 *
 * The second suite covers the ways a run can regenerate LESS than everything.
 * The digest is one GLOBAL fact, so anything that narrows the work — a scoped
 * `refresh --stale`, or pending-candidate deduplication — can advance it past
 * pages that were never touched, leaving them current and permanently stale.
 */

import { describe, it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  mockClaudeEnv,
  stubCannedCompile,
  useAimockLifecycle,
} from "./fixtures/aimock-helper.js";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("prompt-modifiers");

/** The recorded modifier digest in the project's state.json. */
async function recordedDigest(cwd: string): Promise<string | undefined> {
  const raw = await readFile(path.join(cwd, ".llmwiki/state.json"), "utf-8");
  return (JSON.parse(raw) as { promptModifiers?: string }).promptModifiers;
}

describe("a flipped prompt modifier invalidates already-compiled pages", () => {
  it("recompiles on the second run, and records the new selection", async () => {
    const handle = await aimock.start();
    stubCannedCompile(handle, "Modifier Concept");
    const cwd = await aimock.makeWorkspace("# Source\n\nA source for the modifier test.\n");
    const env = mockClaudeEnv(handle);

    const first = await runCLI(["compile"], cwd, env);
    expectCLIExit(first, 0);
    expect(await recordedDigest(cwd)).toBe("");

    // Byte-identical sources. Without the modifier fingerprint this run reports
    // "Nothing to compile" and the page keeps its previous wording.
    const second = await runCLI(["compile", "--lang", "Japanese"], cwd, env);
    expectCLIExit(second, 0);
    expect(second.stdout).not.toContain("Nothing to compile");

    const digest = await recordedDigest(cwd);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  }, 180_000);

  it("leaves a settled project alone when nothing was flipped", async () => {
    const handle = await aimock.start();
    stubCannedCompile(handle, "Modifier Concept");
    const cwd = await aimock.makeWorkspace("# Source\n\nAnother modifier-test source.\n");
    const env = mockClaudeEnv(handle);

    expectCLIExit(await runCLI(["compile"], cwd, env), 0);
    const second = await runCLI(["compile"], cwd, env);
    expectCLIExit(second, 0);
    expect(second.stdout).toContain("Nothing to compile");
  }, 180_000);
});

describe("a run that regenerates nothing must not record the new selection", () => {
  it("keeps a pending candidate's selection from being dedup'd away", async () => {
    const handle = await aimock.start();
    stubCannedCompile(handle, "Scope Concept");
    const cwd = await aimock.makeWorkspace("# Source\n\nA source for the candidate test.\n");
    const env = mockClaudeEnv(handle);

    // A pending candidate exists, produced under Japanese.
    expectCLIExit(await runCLI(["compile", "--review", "--lang", "Japanese"], cwd, env), 0);
    const afterFirst = handle.mock.getRequests().length;

    // Same bytes, different selection. markUnchangedPendingSources dedupes on
    // the source hash alone, so it demotes the promotion right back.
    const second = await runCLI(["compile", "--review", "--lang", "Spanish"], cwd, env);
    expectCLIExit(second, 0);
    expect(handle.mock.getRequests().length).toBeGreaterThan(afterFirst);
  }, 180_000);

  it("regenerates when the only modifier is CLEARED, not just changed", async () => {
    // The inverse of the case above, and the one a state-based comparison
    // cannot see: review mode never flushes state, so a project whose only
    // compiles were --review has no recorded digest — and an absent digest
    // means "none selected", exactly what clearing a modifier requests.
    const handle = await aimock.start();
    stubCannedCompile(handle, "Cleared Concept");
    const cwd = await aimock.makeWorkspace("# Source\n\nA source for the clear test.\n");
    const env = mockClaudeEnv(handle);

    expectCLIExit(await runCLI(["compile", "--review", "--lang", "Japanese"], cwd, env), 0);
    const afterFirst = handle.mock.getRequests().length;

    expectCLIExit(await runCLI(["compile", "--review"], cwd, env), 0);
    expect(handle.mock.getRequests().length).toBeGreaterThan(afterFirst);
  }, 180_000);

  it("does not advance the digest when the run was scoped to a subset", async () => {
    const handle = await aimock.start();
    stubCannedCompile(handle, "Scope Concept");
    const cwd = await aimock.makeWorkspace("# A\n\nFirst source.\n");
    await writeFile(path.join(cwd, "sources/b.md"), "# B\n\nSecond source.\n");
    const env = { ...mockClaudeEnv(handle), LLMWIKI_OUTPUT_LANG: "Japanese" };

    expectCLIExit(await runCLI(["compile"], cwd, env), 0);
    const japanese = await recordedDigest(cwd);

    // Edit the EXISTING source so its page goes stale. refresh --stale then
    // scopes the compile through a changeFilter — a new file would be skipped
    // outright and the run would prove nothing.
    await writeFile(
      path.join(cwd, "sources/intro.md"),
      "# A\n\nFirst source, substantially edited so its page is stale.\n",
    );
    const spanish = { ...mockClaudeEnv(handle), LLMWIKI_OUTPUT_LANG: "Spanish" };
    expectCLIExit(await runCLI(["refresh", "--stale"], cwd, spanish), 0);

    // b.md was never regenerated, so the Spanish selection is not yet true of
    // the project and must not be recorded as though it were.
    expect(await recordedDigest(cwd)).toBe(japanese);
  }, 180_000);
});
