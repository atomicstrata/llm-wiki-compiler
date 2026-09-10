/** Exercise actual TypeScript semantic checking, including nested files and no emit. */
import { afterEach, beforeEach, expect, it } from "vitest";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectTestDiagnostics } from "../scripts/test-typecheck-program.js";
import { createTypecheckProject } from "./fixtures/test-typecheck-project.js";

let root: string;
beforeEach(async () => { root = await createTypecheckProject(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("finds a semantic error in a nested test and clears it when corrected", async () => {
  const file = path.join(root, "test", "nested", "probe.ts");
  await writeFile(file, "export const value: string = 42;\n");
  expect(collectTestDiagnostics(root).counts).toEqual({ "test/nested/probe.ts": 1 });
  await writeFile(file, 'export const value: string = "fixed";\n');
  expect(collectTestDiagnostics(root).counts).toEqual({});
  expect(await readdir(path.dirname(file))).toEqual(["probe.ts"]);
});

it("refuses a test configuration that permits emitting files", async () => {
  const config = path.join(root, "tsconfig.test.json");
  const value = JSON.parse(await readFile(config, "utf8"));
  value.compilerOptions.noEmit = false;
  await writeFile(config, JSON.stringify(value));
  await writeFile(path.join(root, "test", "probe.ts"), "export const value = 42;\n");
  expect(() => collectTestDiagnostics(root)).toThrow(/noEmit/);
});

it("does not allow a config exclusion to hide a nested test", async () => {
  const config = path.join(root, "tsconfig.test.json");
  const value = JSON.parse(await readFile(config, "utf8"));
  value.exclude = ["test/nested"];
  await writeFile(config, JSON.stringify(value));
  await writeFile(path.join(root, "test", "probe.ts"), "export const ok = 1;\n");
  await writeFile(path.join(root, "test", "nested", "hidden.ts"), "export const wrong: string = 42;\n");
  expect(() => collectTestDiagnostics(root)).toThrow(/unchecked.*test\/nested\/hidden.ts/i);
});

it("does not silently omit dot-prefixed test files from semantic checking", async () => {
  await writeFile(path.join(root, "test", "probe.ts"), "export const ok = 1;\n");
  await writeFile(path.join(root, "test", ".dot.test.ts"), "export const wrong: string = 42;\n");
  expect(() => collectTestDiagnostics(root)).toThrow(/unchecked.*test\/\.dot\.test\.ts/i);
  const configPath = path.join(root, "tsconfig.test.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.files = ["test/.dot.test.ts"];
  await writeFile(configPath, JSON.stringify(config));
  expect(collectTestDiagnostics(root).counts).toEqual({ "test/.dot.test.ts": 1 });
});
