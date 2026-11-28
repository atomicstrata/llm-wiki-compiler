/**
 * @file test/public-boundary/declaration-scoped-dependencies.test.mjs
 * @description Witnesses for which imports the release gate's dependency check
 * (`scripts/public-boundary/dependencies.mjs`) counts as a public package's
 * dependencies.
 *
 * The core package's per-module entries (`core:modules/*`) are bundled without
 * declarations, so a type-only import reached only through them is erased from
 * the JavaScript and appears in no emitted declaration: it needs no dependency.
 * Every runtime or dynamic import through those entries still does, and so does
 * every type-only import reached from a typed entry, directly, transitively or
 * through a module a per-module entry reached first.
 *
 * Every case writes a small scratch tree whose CLI file names the per-module
 * entries, so the real `releaseComposition` derives them, and runs the gate's
 * own modules over it. Nothing is built, installed or executed.
 */

import { describe, expect, it } from "bun:test";
import { releaseComposition } from "../../scripts/public-boundary/composition.mjs";
import { checkDependencies } from "../../scripts/public-boundary/dependencies.mjs";
import { scratchTreePerCase, writeTree } from "./scratch-tree.mjs";

/** The core package: its `./modules/*` subpaths are the per-module entries. */
const CORE = "@atomicstrata/llmwiki-core";
const RANGE = "^13.0.0";
/** A module whose only outside reference is a type-only import. */
const TYPE_IMPORT = 'import type { Command } from "commander";\nexport type Shape = Command;\n';

/** The scratch source tree of the current case. */
let root;

/**
 * The fixture manifest: typed entry `core:index` (`src/core.ts`), and, when `firstModule` is given, that
 * per-module entry listed before it so it is visited first. `declared` is the core allowlist.
 */
function manifestOf(declared, firstModule) {
  return {
    publicRelease: { entries: { "core:index": "src/core.ts" }, inRepositoryPackages: [CORE] },
    packageEntries: { [CORE]: "src/core.ts" },
    publicPackages: [{ name: CORE, entries: firstModule ? [`core:modules/${firstModule}`, "core:index"] : ["core:index"] }],
    graph: { allowedConstructs: [] },
    publicDependencies: { releaseVersion: "2.0.0", baselineVersion: "1.0.0", packages: { [CORE]: { dependencies: declared } }, approvedAdditions: [] },
  };
}

/**
 * Write the typed entry, a CLI file importing each per-module entry in `modules`, and `files`; then run the
 * real dependency check with `declared` as the allowlist and the baseline. Returns the check and the derived
 * per-module names.
 */
function check({ files, modules, declared = {}, firstModule }) {
  const cli = modules.map((name) => `import "${CORE}/modules/${name}";`).join("\n");
  writeTree(root, { "src/commands/.keep": "", "src/cli/main.ts": `${cli}\n`, "src/core.ts": "export const core = 1;\n", ...files });
  const manifest = manifestOf(declared, firstModule);
  const result = checkDependencies(root, manifest, { packages: { [CORE]: { dependencies: declared } } });
  return { result, moduleNames: releaseComposition(root, manifest).moduleNames };
}

/** Runtime and dynamic imports of an undeclared package through a per-module entry: both are runtime uses. */
const UNTYPED_ENTRY_IMPORTS = [
  ["runtime", 'import pad from "left-pad";\nexport const run = pad;\n'],
  ["dynamic", 'export const run = () => import("left-pad");\n'],
];

/** The finding for `name`, imported over `edge` by `from` and missing from the core allowlist. */
const missing = (name, edge, from) => ({ package: CORE, kind: "imported-package-not-in-allowlist", name, edge, from });

describe("the dependency check counts type-only imports only where declarations ship", () => {
  scratchTreePerCase("declaration-scoped-dependencies-", (created) => { root = created; });

  it("needs no dependency for a type-only import reached only through a per-module entry", () => {
    const { result, moduleNames } = check({ modules: ["cli/option"], files: { "src/cli/option.ts": TYPE_IMPORT } });
    expect(moduleNames).toEqual(["cli/option"]);
    expect(result.findings).toEqual([]);
    const declared = check({ modules: ["cli/option"], files: { "src/cli/option.ts": TYPE_IMPORT }, declared: { commander: RANGE } });
    expect(declared.result.packages[0].declaredButNotImported).toEqual(["commander"]);
  });

  it.each(UNTYPED_ENTRY_IMPORTS)("still rejects an undeclared %s import through a per-module entry", (_kind, text) => {
    const { result } = check({ modules: ["cli/run"], files: { "src/cli/run.ts": text } });
    expect(result.findings).toEqual([missing("left-pad", "runtime", "src/cli/run.ts")]);
  });

  it("still requires a type-only dependency of a typed entry", () => {
    const { result } = check({ modules: ["cli/option"], files: { "src/cli/option.ts": "export const option = 1;\n", "src/core.ts": TYPE_IMPORT } });
    expect(result.findings).toEqual([missing("commander", "type-only", "src/core.ts")]);
  });

  it("requires a transitive type-only dependency of a typed entry, and accepts it once declared", () => {
    const files = { "src/cli/option.ts": "export const option = 1;\n", "src/core.ts": 'export type { Shape } from "./shape.js";\n', "src/shape.ts": TYPE_IMPORT };
    expect(check({ modules: ["cli/option"], files }).result.findings).toEqual([missing("commander", "type-only", "src/shape.ts")]);
    const { result } = check({ modules: ["cli/option"], files, declared: { commander: RANGE } });
    expect(result.findings).toEqual([]);
    expect(result.packages[0].declaredButNotImported).toEqual([]);
  });

  it("counts a shared module's type-only dependency for a typed entry even when a per-module entry reached it first", () => {
    const files = {
      "src/cli/option.ts": 'import { shared } from "../shared.js";\nexport const option = shared;\n',
      "src/core.ts": 'import { shared } from "./shared.js";\nexport const core = shared;\n',
      "src/shared.ts": `${TYPE_IMPORT}export const shared = 1;\n`,
    };
    const { result } = check({ modules: ["cli/option"], files, firstModule: "cli/option" });
    expect(result.findings).toEqual([missing("commander", "type-only", "src/shared.ts")]);
  });
});
