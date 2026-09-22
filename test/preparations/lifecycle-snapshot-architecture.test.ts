/**
 * @file test/preparations/lifecycle-snapshot-architecture.test.ts
 * @description Structural guard for the Task 9B authority-layer direction.
 * Filesystem observation may feed snapshot classification, but neither layer
 * may import compatibility projections or root-taking lifecycle drivers.
 */

import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const PREPARATIONS = path.join(ROOT, "src", "preparations");
const LIFECYCLE_FS = path.join(ROOT, "src", "preparations", "lifecycle-fs");
const SNAPSHOT = path.join(ROOT, "src", "preparations", "lifecycle-snapshot");

/** Read every TypeScript module directly inside one authority layer. */
async function layerSources(directory: string): Promise<readonly [string, string][]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".ts")).sort();
  return Promise.all(names.map(async (name) => [
    name,
    await readFile(path.join(directory, name), "utf8"),
  ] as const));
}

/** Return one stable list of forbidden import fragments present in a source. */
function forbiddenImports(source: string, fragments: readonly string[]): string[] {
  return fragments.filter((fragment) => source.includes(fragment));
}

/** Known sibling-classifier declarations this migration permanently absorbs. */
function siblingClassifierDeclarations(source: string): string[] {
  const names = [
    "classifyQuarantineUnit",
    "classifyPruneUnit",
    "resolvePruneRegistryState",
  ];
  return names.filter((name) =>
    new RegExp(`function\\s+${name}\\b`, "u").test(source));
}

/** Read the original names imported from one exact module specifier. */
function namedImportsFrom(source: string, moduleName: string): string[] {
  const parsed = ts.createSourceFile("module.ts", source, ts.ScriptTarget.ESNext, true);
  const names: string[] = [];
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== moduleName) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    names.push(...bindings.elements.map((element) =>
      element.propertyName?.text ?? element.name.text));
  }
  return names.sort();
}

describe("preparation lifecycle authority architecture", () => {
  it("does not retain the transitional prune classifier", async () => {
    const legacy = path.join(ROOT, "src", "preparations", "prune-registry.ts");
    await expect(access(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not resurrect either known registry-specific classifier", async () => {
    const names = (await readdir(PREPARATIONS))
      .filter((name) => name.endsWith(".ts"));
    for (const name of names) {
      const source = await readFile(path.join(PREPARATIONS, name), "utf8");
      expect(siblingClassifierDeclarations(source), name).toEqual([]);
    }
  });

  it("keeps filesystem observation below snapshot and compatibility layers", async () => {
    for (const [name, source] of await layerSources(LIFECYCLE_FS)) {
      expect(forbiddenImports(source, [
        "lifecycle-snapshot",
        "lifecycle-compat",
      ]), name).toEqual([]);
    }
  });

  it("keeps snapshot classification away from raw fs and root-taking drivers", async () => {
    const forbidden = [
      "node:fs",
      "fs/promises",
      "lifecycle-compat",
      "../prune-registry",
      "../quarantine.js",
      "../reset.js",
      "../retention.js",
      "../recovery.js",
      "../references.js",
    ];
    for (const [name, source] of await layerSources(SNAPSHOT)) {
      expect(forbiddenImports(source, forbidden), name).toEqual([]);
    }
  });

  it("keeps capacity off the destructive compatibility traversal", async () => {
    const capacity = await readFile(path.join(PREPARATIONS, "capacity.ts"), "utf8");
    const quarantine = await readFile(path.join(PREPARATIONS, "quarantine.ts"), "utf8");
    expect(namedImportsFrom(capacity, "./orphan-scan.js"))
      .not.toContain("scanPreparationOrphans");
    // NOT asserted for quarantine.ts any more. It required an import that only
    // the deleted uncaptured scanner used, so the control was pinning dead
    // weight: keeping the symbol imported would have been the cheapest way to
    // satisfy it, which is the opposite of what it is for.
    expect(namedImportsFrom(quarantine, "./orphan-scan.js"))
      .not.toContain("scanPreparationOrphans");
  });

  it("proves the structural matcher rejects representative reverse edges", () => {
    const source = 'import { lstat } from "node:fs/promises";\n' +
      'import { project } from "../lifecycle-compat.js";';
    expect(forbiddenImports(source, ["node:fs", "lifecycle-compat"]))
      .toEqual(["node:fs", "lifecycle-compat"]);
    expect(siblingClassifierDeclarations(
      "async function classifyPruneUnit() {}",
    )).toEqual(["classifyPruneUnit"]);
  });
});
