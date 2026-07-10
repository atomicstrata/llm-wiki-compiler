/**
 * @file test/compile-reroute-cli.test.ts
 * @description SUBPROCESS (real-CLI) integration coverage for the compile-reroute
 * crash-recovery contract: a crash leaves a `pending` intent journal that the NEXT
 * compile recovers (via `recoverJournalBeforeCompile`) before reading, read
 * surfaces flag `incomplete-compile`/`journal-unavailable`, and `llmwiki recover`
 * reverts an incomplete compile without recompiling. These guarantees are well
 * covered IN-PROCESS; this suite adds the missing END-TO-END coverage through the
 * REAL CLI binary (`dist/cli.js` via `runCLI`), with a MOCKED LLM provider.
 *
 * WHY THERE IS NO TRUE-SIGKILL TEST: a deterministic mid-batch crash would require
 * a production-only crash seam, which is deliberately avoided. The in-process
 * fault-injection suite (`compile-reroute-phases.test.ts`) already exercises a
 * real pipeline-produced pending journal + the real recovery within one process;
 * this suite complements it by adding the CROSS-PROCESS recovery of a real on-disk
 * journal through the real CLI — we PLANT a `pending` journal whose recorded
 * target is a real in-root page with a captured pre-state, then invoke the real
 * binary and assert it recovers/reports it. Together they cover both the
 * pipeline-produced and the on-disk-planted journal through every surface.
 *
 * NOTE ON `status`: there is no `llmwiki status` CLI command; the journal-health
 * signal reaches a user through `llmwiki lint` (human stdout, prefixed with the
 * stable code) and `llmwiki context <prompt> --json` (`warnings[].code`). Those
 * are the real CLI surfaces asserted here for scenarios 3 and 4 (verified against
 * actual output, not assumed).
 */

import { describe, it, expect } from "vitest";
import { readFile, writeFile, mkdir, rm, mkdtemp, realpath } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { runCLI, expectCLIExit, expectCLIFailure, formatCLIFailure } from "./fixtures/run-cli.js";
import { useAimockLifecycle, mockOpenAIEnv } from "./fixtures/aimock-helper.js";
import {
  stubAlphaCompile,
  setupProject,
  plantCrashedBatch,
  journalIsEmpty,
  ALPHA_SOURCE,
  ALPHA_PAGE_REL,
} from "./fixtures/reroute-cli-helper.js";
import {
  plantPendingEscapingTargetBatch,
  plantSymlinkedJournalDir,
} from "./trust/journal-fixture.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";

const aimock = useAimockLifecycle("reroute-cli");
const COMPILE_TIMEOUT = 90_000;

/** Boot aimock + a realpath'd workspace, returning the running handle and root. */
async function bootCompileProject(): Promise<{ handle: Awaited<ReturnType<typeof aimock.start>>; cwd: string }> {
  const handle = await aimock.start();
  stubAlphaCompile(handle);
  const cwd = await setupProject(await aimock.makeWorkspace(ALPHA_SOURCE));
  return { handle, cwd };
}

describe("compile reroute — real-CLI smoke (scenario 1)", () => {
  it("compiles a page end-to-end through the binary and leaves the journal empty", async () => {
    const { handle, cwd } = await bootCompileProject();
    const result = await runCLI(["compile"], cwd, mockOpenAIEnv(handle));
    expectCLIExit(result, 0);
    const page = path.join(cwd, ALPHA_PAGE_REL);
    expect(existsSync(page), formatCLIFailure(result)).toBe(true);
    expect(await readFile(page, "utf-8")).toContain("Body paragraph");
    expect(await journalIsEmpty(cwd), "journal must be commit-pruned empty").toBe(true);
  }, COMPILE_TIMEOUT);
});

describe("compile reroute — crash-recovery converges cross-process (scenario 2)", () => {
  it("recovers a planted pending journal BEFORE reading, then recompiles to convergence", async () => {
    const { handle, cwd } = await bootCompileProject();
    expectCLIExit(await runCLI(["compile"], cwd, mockOpenAIEnv(handle)), 0);
    // Plant a half-applied crash: page overwritten, journal records true pre-state.
    await plantCrashedBatch(cwd);
    const result = await runCLI(["compile"], cwd, mockOpenAIEnv(handle));
    expectCLIExit(result, 0);
    const body = await readFile(path.join(cwd, ALPHA_PAGE_REL), "utf-8");
    // Recover-before-read reverted the post-crash bytes; recompile restored content.
    expect(body, formatCLIFailure(result)).not.toContain("POST-CRASH");
    expect(body).toContain("Body paragraph");
    expect(await journalIsEmpty(cwd), "recovered journal must not accumulate").toBe(true);
  }, COMPILE_TIMEOUT);
});

describe("compile reroute — health surfaced + recover via real CLI (scenario 3)", () => {
  it("lint + context show incomplete-compile; recover reverts without recompiling", async () => {
    const { handle, cwd } = await bootCompileProject();
    expectCLIExit(await runCLI(["compile"], cwd, mockOpenAIEnv(handle)), 0);
    const preCrashBytes = await plantCrashedBatch(cwd);
    const lint = await runCLI(["lint"], cwd);
    expect(lint.stdout, formatCLIFailure(lint)).toContain("incomplete-compile:");
    const ctx = await runCLI(["context", "Alpha", "--json"], cwd);
    const warnings = (JSON.parse(ctx.stdout) as { warnings: { code: string }[] }).warnings;
    expect(warnings.map((w) => w.code)).toContain("incomplete-compile");
    // recover (no recompile): reverts the page to pre-state and clears the journal.
    const rec = await runCLI(["recover"], cwd);
    expectCLIExit(rec, 0);
    expect(rec.stdout).toContain("Reverted an incomplete compile");
    expect(await readFile(path.join(cwd, ALPHA_PAGE_REL), "utf-8")).toBe(preCrashBytes);
    expect(await journalIsEmpty(cwd)).toBe(true);
    expect((await runCLI(["lint"], cwd)).stdout).not.toContain("incomplete-compile:");
  }, COMPILE_TIMEOUT);
});

/**
 * Plant an escaping-target pending journal into a fresh project; returns root +
 * victim. Seeds a real source so `compile` reaches the strict recover-before-read
 * seam (an empty project would short-circuit at "No sources found" and never
 * exercise the fail-closed abort).
 */
async function plantTamperedProject(): Promise<{ root: string; victim: string; before: string }> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "reroute-tamper-")));
  await mkdir(path.join(root, "sources"), { recursive: true });
  await writeFile(path.join(root, "sources", "intro.md"), ALPHA_SOURCE, "utf-8");
  await mkdir(path.join(root, CONCEPTS_DIR), { recursive: true });
  const victim = await plantPendingEscapingTargetBatch(root, "evil");
  return { root, victim, before: await readFile(victim, "utf-8") };
}

describe("compile reroute — tamper fail-closed via real CLI (scenario 4)", () => {
  it("escaping target: context flags journal-unavailable; recover+compile fail closed", async () => {
    const handle = await aimock.start();
    stubAlphaCompile(handle);
    const { root, victim, before } = await plantTamperedProject();
    try {
      const ctx = await runCLI(["context", "x", "--json"], root);
      const codes = (JSON.parse(ctx.stdout) as { warnings: { code: string }[] }).warnings.map((w) => w.code);
      expect(codes).toContain("journal-unavailable");
      expectCLIFailure(await runCLI(["recover"], root)); // tamper error, nonzero
      expectCLIFailure(await runCLI(["compile"], root, mockOpenAIEnv(handle))); // strict abort
      expect(await readFile(victim, "utf-8"), "outside victim must be byte-unchanged").toBe(before);
    } finally {
      await rm(victim, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  }, COMPILE_TIMEOUT);

  it("symlink-escaping journal dir: lint flags journal-unavailable; recover fails closed", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "reroute-symtamper-")));
    const outside = await mkdtemp(path.join(tmpdir(), "reroute-outside-"));
    try {
      await mkdir(path.join(root, CONCEPTS_DIR), { recursive: true });
      const victim = await plantSymlinkedJournalDir(root, outside);
      expect((await runCLI(["lint"], root)).stdout).toContain("journal-unavailable:");
      expectCLIFailure(await runCLI(["recover"], root));
      expect(await readFile(victim, "utf-8")).toBe("OUTSIDE-DATA");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("compile reroute — journal bounded across N real compiles (scenario 5)", () => {
  it("stays empty after each of three real compile process invocations", async () => {
    const { handle, cwd } = await bootCompileProject();
    for (let pass = 0; pass < 3; pass++) {
      const result = await runCLI(["compile"], cwd, mockOpenAIEnv(handle));
      expectCLIExit(result, 0);
      expect(await journalIsEmpty(cwd), `journal grew after compile #${pass + 1}`).toBe(true);
    }
  }, COMPILE_TIMEOUT);
});
