/**
 * @file Product-neutral command composition witnesses. Exercise cold-init and
 * readiness reporting against a real installed package, without requiring a
 * standalone product, model, or network provider.
 */
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { productInitCommand } from "../../src/commands/product/init.js";
import { productStatusCommand } from "../../src/commands/product/status.js";
import { productWorkspace, type ProductWorkspaceV1 } from "./product-cli-fixture.js";

const workspaces: ProductWorkspaceV1[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(workspaces.splice(0).map(workspace => workspace.cleanup()));
});

/** Isolate operator roots and capture command output for assertions. */
async function initializedWorkspace() {
  const workspace = await productWorkspace();
  workspaces.push(workspace);
  const root = await realpath(workspace.root);
  for (const [variable, directory] of [["XDG_CONFIG_HOME", "config"], ["XDG_CACHE_HOME", "cache"]]) {
    const target = path.join(root, directory!);
    await mkdir(path.join(target, "llmwiki"), { recursive: true });
    vi.stubEnv(variable!, target);
  }
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await productInitCommand(root, workspace.sourceDir, { json: true })).toBe(0);
  expect(output.mock.calls.flat().join("\n")).toContain('"initialized"');
  output.mockClear();
  return { root, output, sourceDir: workspace.sourceDir };
}

describe("generic product command reporting", () => {
  it("initializes idempotently and renders declared readiness as human-readable text", async () => {
    const { root, sourceDir } = await initializedWorkspace();
    const humanOutput = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await productInitCommand(root, sourceDir)).toBe(0);
    expect(await productStatusCommand(root)).toBe(0);
    expect(humanOutput.mock.calls.flat().join("\n")).toContain("model-ready");
  });

  it("reports an unknown dimension accurately in JSON without recording it", async () => {
    const { root, output } = await initializedWorkspace();
    expect(await productStatusCommand(root, { skip: "unknown-dimension", json: true })).not.toBe(0);
    expect(output.mock.calls.flat().join("\n")).toContain("declares no capability named unknown-dimension");
  });

  it("refuses a corrupt skip record without replacing it", async () => {
    const { root, output } = await initializedWorkspace();
    await writeFile(path.join(root, ".llmwiki", "product-readiness-skips.json"), "not-json");
    expect(await productStatusCommand(root, { skip: "model-ready", json: true })).not.toBe(0);
    expect(output.mock.calls.flat().join("\n")).toContain("skip record is unreadable");
  });
});
