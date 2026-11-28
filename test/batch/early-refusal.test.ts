/**
 * @file test/batch/early-refusal.test.ts
 * @description The SDK and the CLI answer an option a project's compile body
 * does not support with that option's own refusal, BEFORE any provider
 * credential is asked for, and without a model call or a durable change.
 * The test process holds no provider credential, so a path that reached the
 * credential check first would fail with a missing-key error instead.
 *
 * The classic compile is unchanged: on an ordinary project `--no-pages-limit`
 * is accepted by the same early check and goes on to the credential check.
 */

import { Command } from "commander";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { afterAll, afterEach, beforeAll } from "../config/storage-profile-hooks.js";
import { registerCompileCommand } from "../../src/cli/compile-command.js";
import { assertCompileOptionsRoutable } from "../../src/compiler/batch/route.js";
import { createWikiCore } from "../../src/sdk/core.js";
import { segment, sourceNaming, writeSources } from "./helpers.js";

/** Preparing the segmented project costs tens of durable commits; on a busy test volume each took several seconds (measured about 9 s). */
const FIXTURE_TIMEOUT_MS = 600_000;
let segmented = "";
let plain = "";

beforeAll(async () => {
  segmented = await mkdtemp(path.join(tmpdir(), "llmwiki-early-segmented-"));
  plain = await mkdtemp(path.join(tmpdir(), "llmwiki-early-plain-"));
  for (const root of [segmented, plain]) {
    await writeSources(root, { "a.md": sourceNaming("A", "Idea") });
    await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  }
  await segment(segmented);
}, FIXTURE_TIMEOUT_MS);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { for (const root of [segmented, plain]) await rm(root, { recursive: true, force: true }); });

/** Whether the segmented project holds any run store or concept page. */
async function untouched(): Promise<boolean> {
  const stores = await readdir(path.join(segmented, ".llmwiki", "indexed"));
  return !stores.some((store) => store.startsWith("crun-")) && (await readdir(path.join(segmented, "wiki", "concepts"))).length === 0;
}

/** Run `llmwiki compile <flags>` in `cwd`; returns what it printed as an error and whether the credential guard ran. */
async function runCompileCli(cwd: string, flags: string[]): Promise<{ error: string; credentialChecks: number }> {
  const errors: string[] = [];
  let credentialChecks = 0;
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => { errors.push(parts.join(" ")); });
  vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
  const program = new Command().exitOverride();
  registerCompileCommand(program.command("compile"), { requireCompileProvider: () => { credentialChecks += 1; throw new Error("credential check reached"); } });
  await program.parseAsync(["node", "llmwiki", "compile", ...flags]).catch(() => undefined);
  return { error: errors.join("\n"), credentialChecks };
}

describe("an unsupported compile option refuses before credentials", () => {
  it.each([
    ["--no-pages-limit", { noPagesLimit: true, embeddings: false }],
    ["--review", { review: true, embeddings: false }],
    ["an embeddings refresh", {}],
  ])("SDK: a batch project refuses %s with its own refusal", async (_label, options) => {
    await expect(createWikiCore({ root: segmented }).compile(options)).rejects.toThrow(/compile_batch_unsupported_option/);
    expect(await untouched()).toBe(true);
  });

  it("SDK: an ordinary project refuses a batch-only option with its own refusal", async () => {
    await expect(createWikiCore({ root: plain }).compile({ batchSize: 2 })).rejects.toThrow(/compile_batch_unsupported_option/);
  });

  it.each([[["--no-pages-limit", "--no-embeddings"]], [["--review", "--no-embeddings"]], [[] as string[]]])("CLI: a batch project refuses %j before the credential guard", async (flags) => {
    const run = await runCompileCli(segmented, flags);
    expect(run.error).toMatch(/compile_batch_unsupported_option/u);
    expect(run.credentialChecks).toBe(0);
    expect(await untouched()).toBe(true);
  });

  it("CLI: an ordinary project refuses --batch-size before the credential guard", async () => {
    const run = await runCompileCli(plain, ["--batch-size", "2"]);
    expect(run.error).toMatch(/compile_batch_unsupported_option/u);
    expect(run.credentialChecks).toBe(0);
  });
});

describe("the classic compile keeps --no-pages-limit", () => {
  it("accepts it in the early check and goes on to the credential guard", async () => {
    await expect(assertCompileOptionsRoutable(plain, { noPagesLimit: true })).resolves.toBeUndefined();
    const run = await runCompileCli(plain, ["--no-pages-limit"]);
    expect(run.credentialChecks).toBe(1);
    expect(run.error).toMatch(/credential check reached/u);
  });
});
