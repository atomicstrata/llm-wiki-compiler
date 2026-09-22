/**
 * @file test/products/product-status-skip-cli.test.ts
 * @description The §4.1 configure-or-skip flow through the SHIPPED CLI: an
 * operator declines an optional capability, the decision is DURABLE across
 * separate processes, the review reports the decision rather than re-nudging,
 * and clearing it restores the honest readiness state.
 *
 * EACH STEP IS ITS OWN CHILD PROCESS, because durability is the claim: a skip
 * that only survived within one process's memory would pass any in-process
 * test and still re-prompt the operator tomorrow. A skip of an undeclared
 * dimension must REFUSE — recording it would preserve a typo forever.
 */

import path from "node:path";
import { mkdir, realpath } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runCLI, expectCLIExit } from "../fixtures/run-cli.js";
import { activatedProject } from "./product-vertical-fixture.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

const DIMENSION = "model-ready";

/** Install only a generic product; status needs no model, source, or ingest run. */
async function gateState() {
  const project = await activatedProject();
  cleanup = project.cleanup;
  const root = await realpath(project.root);
  await Promise.all(["test-config", "test-cache"].map(directory =>
    mkdir(path.join(root, directory, "llmwiki"), { recursive: true })));
  return { root, invokeEnv: {
    XDG_CONFIG_HOME: path.join(root, "test-config"),
    XDG_CACHE_HOME: path.join(root, "test-cache"),
  } };
}

/** Each status call is a fresh process with isolated operator stores. */
async function runCli(root: string, env: Record<string, string>, ...args: string[]): Promise<string> {
  const result = await runCLI(args, root, env);
  if (result.code !== 0) throw new Error(`${result.stderr}${result.stdout}`);
  expectCLIExit(result, 0);
  return result.stdout;
}

/** The one declared dimension's row from a fresh `product status --json`. */
async function statusRow(root: string, env: Readonly<Record<string, string>>): Promise<{ state: string }> {
  const stdout = await runCli(root, env, "product", "status", "--json");
  const parsed = JSON.parse(stdout) as { items: { dimensionId: string; state: string }[] };
  const row = parsed.items.find((item) => item.dimensionId === DIMENSION);
  if (row === undefined) throw new Error(`no ${DIMENSION} row in: ${stdout}`);
  return row;
}

describe("§4.1 skip-or-configure through the shipped CLI", () => {
  it("records a DURABLE skip, reports the decision, and clears it on unskip", async () => {
    const { root, invokeEnv } = await gateState();
    const before = await statusRow(root, invokeEnv);
    expect(before.state).not.toBe("skipped");

    await runCli(root, invokeEnv, "product", "status", "--skip", DIMENSION, "--json");
    // A SEPARATE process reads the decision back: durability, not memory.
    expect((await statusRow(root, invokeEnv)).state).toBe("skipped");

    await runCli(root, invokeEnv, "product", "status", "--unskip", DIMENSION, "--json");
    expect((await statusRow(root, invokeEnv)).state).toBe(before.state);
  }, 240_000);

  it("REFUSES to record a skip for a dimension the product never declared", async () => {
    const { root, invokeEnv } = await gateState();
    await expect(runCli(root, invokeEnv, "product", "status", "--skip", "no-such-dimension", "--json"))
      .rejects.toThrow(/no-such-dimension|declares|unknown/i);
    expect((await statusRow(root, invokeEnv)).state).not.toBe("skipped");
  }, 240_000);
});
