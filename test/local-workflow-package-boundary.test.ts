/**
 * Source-level package boundary checks, including type-only import declarations.
 * The externalized build proves the engine can use the declared contracts seam;
 * installed tarball and consumer checks remain a separate integration gate.
 */
import { expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";
import { build } from "esbuild";
import { SRC_DIR, srcTsFiles } from "./fixtures/src-tree.js";
import { literalModuleImports } from "./fixtures/module-imports.js";

const CONTRACTS = "@atomicstrata/llmwiki-core/local-workflow-contracts";

it("keeps scoped support packages public and version-aligned behind the standard facade", () => {
  const root = path.dirname(SRC_DIR);
  const facade = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  expect(facade.name).toBe("llm-wiki-compiler");
  for (const directory of ["llmwiki-core", "llmwiki-local-workflows"]) {
    const manifest = JSON.parse(readFileSync(path.join(root, "packages", directory, "package.json"), "utf8"));
    expect(manifest.name).toBe(`@atomicstrata/${directory}`);
    expect(manifest.publishConfig.access).toBe("public");
    expect(manifest.version).toBe(facade.version);
    expect(facade.dependencies[manifest.name]).toBe(facade.version);
    expect(facade.dependencies[directory]).toBeUndefined();
  }
});

/** Extract npm package identity while excluding relative and Node imports. */
function dependencyName(specifier: string): string[] {
  if (specifier.startsWith(".") || specifier.startsWith("node:") || builtinModules.includes(specifier)) return [];
  return [specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/")];
}

it("declares exactly the dependencies used by built core JavaScript and declarations", () => {
  // Fallow assigns shared src/ imports to the root workspace, not this package.
  // Audit the delivered output instead, including types needed by SDK consumers.
  const directory = path.join(SRC_DIR, "../packages/llmwiki-core");
  const imports = readdirSync(path.join(directory, "dist"))
    .filter(file => file.endsWith(".js") || file.endsWith(".d.ts"))
    .flatMap(file => literalModuleImports(path.join(directory, "dist", file)))
    .flatMap(dependencyName);
  const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
  expect([...new Set(imports)].sort()).toEqual(Object.keys(manifest.dependencies).sort());
});

it("allows engine dependencies only within the engine, Node, or declared core contracts", () => {
  const violations: string[] = [];
  for (const file of srcTsFiles().filter(name => name.startsWith("local-workflows/"))) {
    const source = readFileSync(path.join(SRC_DIR, file), "utf8");
    for (const edge of ts.preProcessFile(source).importedFiles) {
      const specifier = edge.fileName;
      const internal = specifier.startsWith("./")
        && path.resolve(SRC_DIR, path.dirname(file), specifier).startsWith(path.join(SRC_DIR, "local-workflows") + path.sep);
      if (!internal && !specifier.startsWith("node:") && specifier !== CONTRACTS) {
        violations.push(`${file} -> ${specifier}`);
      }
    }
  }
  expect(violations).toEqual([]);
});

it("builds the runtime with contracts external and no compiler implementation embedded", async () => {
  const result = await build({
    absWorkingDir: path.dirname(SRC_DIR), entryPoints: ["src/local-workflows/index.ts"],
    bundle: true, write: false, platform: "node", format: "esm",
    external: [CONTRACTS], metafile: true, logLevel: "silent",
  });
  expect(Object.keys(result.metafile!.inputs).every(file => file.startsWith("src/local-workflows/"))).toBe(true);
  const imports = Object.values(result.metafile!.outputs).flatMap(output => output.imports);
  expect(imports).toContainEqual(expect.objectContaining({ path: CONTRACTS, external: true }));
});

it.each(["src/index.ts", "src/cli.ts"])("builds %s as composition only with both packages external", async (entry) => {
  const result = await build({
    absWorkingDir: path.dirname(SRC_DIR), entryPoints: [entry],
    bundle: true, write: false, platform: "node", format: "esm",
    packages: "external", external: ["@atomicstrata/llmwiki-core", "@atomicstrata/llmwiki-core/*", "@atomicstrata/llmwiki-local-workflows"],
    metafile: true, logLevel: "silent",
  });
  const facade = new Set(["src/index.ts", "src/cli.ts", "src/sdk/wiki.ts", "src/sdk/workflow-facade.ts"]);
  const inputs = Object.keys(result.metafile!.inputs);
  expect(inputs.filter(file => !facade.has(file)
    && !/^src\/(?:workflows\/|cli\/|mcp\/|commands\/workflow[^/]*\.ts$)/.test(file))).toEqual([]);
  for (const file of ["src/cli/shared.ts", "src/cli/provider-option.ts", "src/cli/input-parsers.ts"]) {
    expect(inputs).not.toContain(file);
  }
  const imports = Object.values(result.metafile!.outputs).flatMap(output => output.imports);
  const support = entry === "src/cli.ts" ? "compiler-cli" : "compiler-sdk";
  for (const name of ["@atomicstrata/llmwiki-core", "@atomicstrata/llmwiki-local-workflows", `@atomicstrata/llmwiki-core/${support}`]) {
    expect(imports).toContainEqual(expect.objectContaining({ path: name, external: true }));
  }
});
