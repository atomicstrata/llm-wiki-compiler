/** Run the real gate in small projects; baseline edits must not turn regressions green. */
import { afterEach, beforeEach, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createTypecheckProject } from "./fixtures/test-typecheck-project.js";

const command = fileURLToPath(new URL("../scripts/typecheck-tests.ts", import.meta.url));
let root: string;
beforeEach(async () => { root = await createTypecheckProject(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Invoke the CLI directly, without npm, networking or build output. */
function run(...args: string[]) {
  return spawnSync(process.execPath, [command, ...args], { cwd: root, encoding: "utf8" });
}

/** Seed a valid source and bootstrap the one-time fixture baseline. */
async function seed(body: string): Promise<string> {
  const file = path.join(root, "test", "nested", "probe.ts");
  await writeFile(file, body);
  const result = run("--init");
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return file;
}

it("fails on a new test error and passes after reverting it", async () => {
  const file = await seed('export const value: string = "ok";');
  await writeFile(file, "export const value: string = 42;");
  expect(run().status).toBe(1);
  expect(run("--update").status).toBe(1);
  await writeFile(file, 'export const value: string = "ok";');
  expect(run().status).toBe(0);
});

it("requires lowering the baseline after fixing its last error", async () => {
  const file = await seed("export const value: string = 42;");
  await writeFile(file, 'export const value: string = "ok";');
  expect(run().status).toBe(1);
  expect(run("--update").status).toBe(0);
  expect(JSON.parse(await readFile(path.join(root, "test-typecheck-baseline.json"), "utf8")).counts).toEqual({});
  expect(run().status).toBe(0);
});

it("rejects manual baseline increases relative to a PR base", async () => {
  const file = await seed('export const value: string = "ok";');
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "baseline"], { cwd: root });
  await writeFile(file, "export const value: string = 42;");
  const baselineFile = path.join(root, "test-typecheck-baseline.json");
  const baseline = JSON.parse(await readFile(baselineFile, "utf8"));
  baseline.counts["test/nested/probe.ts"] = 1;
  await writeFile(baselineFile, JSON.stringify(baseline));
  expect(run("--base-ref", "HEAD").status).toBe(1);
});

it("does not overwrite an existing baseline through bootstrap", async () => {
  await seed("export const value = 42;");
  expect(run("--init").status).toBe(1);
});

it.each(["typescript", "configuration"])("refuses a mismatched %s pin", async (field) => {
  await seed("export const value = 42;");
  const file = path.join(root, "test-typecheck-baseline.json");
  const baseline = JSON.parse(await readFile(file, "utf8"));
  baseline[field] = "different";
  await writeFile(file, JSON.stringify(baseline));
  expect(run().status).toBe(1);
  expect(run("--update").status).toBe(1);
});

it("refuses malformed diagnostic allowances", async () => {
  await seed("export const value = 42;");
  const file = path.join(root, "test-typecheck-baseline.json");
  const baseline = JSON.parse(await readFile(file, "utf8"));
  baseline.counts["test/nested/probe.ts"] = -1;
  await writeFile(file, JSON.stringify(baseline));
  expect(run().status).toBe(1);
});
