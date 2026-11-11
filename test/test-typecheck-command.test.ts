/**
 * Run the real gate in small projects; baseline edits must not turn regressions green.
 *
 * Every check spawns the CLI, so a clean project's `--init` runs once, in `beforeAll`,
 * and its baseline is copied into each test that only needs a clean starting point.
 * The copy is valid in another temp directory because the configuration pin holds no
 * checkout path. A project that starts with an error still bootstraps its own baseline.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createTypecheckProject } from "./fixtures/test-typecheck-project.js";

const command = fileURLToPath(new URL("../scripts/typecheck-tests.ts", import.meta.url));
const BASELINE = "test-typecheck-baseline.json";
const PROBE = path.join("test", "nested", "probe.ts");
const VALID = 'export const value: string = "ok";';
const INVALID = "export const value: string = 42;";
let root: string;
let cleanRoot: string;
let cleanBaseline: string;

/** Invoke the CLI directly, without npm, networking or build output. */
function run(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [command, ...args], { cwd, encoding: "utf8" });
}

/** Write the probe and bootstrap the one-time baseline through the real `--init`. */
async function bootstrap(project: string, body: string): Promise<void> {
  await writeFile(path.join(project, PROBE), body);
  const result = run(project, "--init");
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
}

beforeAll(async () => {
  cleanRoot = await createTypecheckProject();
  await bootstrap(cleanRoot, VALID);
  cleanBaseline = await readFile(path.join(cleanRoot, BASELINE), "utf8");
});
afterAll(async () => { await rm(cleanRoot, { recursive: true, force: true }); });
beforeEach(async () => { root = await createTypecheckProject(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Start from the valid probe and the baseline `--init` wrote for it. */
async function seedClean(): Promise<string> {
  await writeFile(path.join(root, BASELINE), cleanBaseline);
  await writeFile(path.join(root, PROBE), VALID);
  return path.join(root, PROBE);
}

/** Parse the baseline so a test can edit it the way a reviewer might. */
async function readBaseline(): Promise<Record<string, unknown> & { counts: Record<string, number> }> {
  return JSON.parse(await readFile(path.join(root, BASELINE), "utf8"));
}

it("bootstraps an empty baseline for a clean project", () => {
  expect(JSON.parse(cleanBaseline).counts).toEqual({});
});

it("fails on a new test error and passes after reverting it", async () => {
  const file = await seedClean();
  await writeFile(file, INVALID);
  expect(run(root).status).toBe(1);
  expect(run(root, "--update").status).toBe(1);
  await writeFile(file, VALID);
  expect(run(root).status).toBe(0);
});

it("requires lowering the baseline after fixing its last error", async () => {
  await bootstrap(root, INVALID);
  expect((await readBaseline()).counts).toEqual({ "test/nested/probe.ts": 1 });
  await writeFile(path.join(root, PROBE), VALID);
  expect(run(root).status).toBe(1);
  expect(run(root, "--update").status).toBe(0);
  expect((await readBaseline()).counts).toEqual({});
  expect(run(root).status).toBe(0);
});

it("rejects manual baseline increases relative to a PR base", async () => {
  const file = await seedClean();
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "baseline"], { cwd: root });
  await writeFile(file, INVALID);
  const baseline = await readBaseline();
  baseline.counts["test/nested/probe.ts"] = 1;
  await writeFile(path.join(root, BASELINE), JSON.stringify(baseline));
  expect(run(root, "--base-ref", "HEAD").status).toBe(1);
});

it("does not overwrite an existing baseline through bootstrap", async () => {
  await seedClean();
  expect(run(root, "--init").status).toBe(1);
  expect(await readFile(path.join(root, BASELINE), "utf8")).toBe(cleanBaseline);
});

it.each(["typescript", "configuration"])("refuses a mismatched %s pin", async (field) => {
  await seedClean();
  const baseline = await readBaseline();
  baseline[field] = "different";
  await writeFile(path.join(root, BASELINE), JSON.stringify(baseline));
  expect(run(root).status).toBe(1);
  expect(run(root, "--update").status).toBe(1);
});

it("refuses malformed diagnostic allowances", async () => {
  await seedClean();
  const baseline = await readBaseline();
  baseline.counts["test/nested/probe.ts"] = -1;
  await writeFile(path.join(root, BASELINE), JSON.stringify(baseline));
  expect(run(root).status).toBe(1);
});
