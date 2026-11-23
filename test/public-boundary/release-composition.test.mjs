/**
 * @file test/public-boundary/release-composition.test.mjs
 * @description Witnesses for the core per-module release composition
 * (`scripts/public-boundary/composition.mjs`) and the release build inputs.
 *
 * The public CLI imports each command's core module by its own subpath
 * (`@atomicstrata/llmwiki-core/modules/<name>`). The ordinary core build, the
 * release builder and the release gate must all derive the SAME module set,
 * map exactly those subpaths and nothing else, and predict each module
 * entry's transitive sources. A name that is malformed, a traversal or has no
 * source must stop the derivation; an unknown subpath must stay unresolved; a
 * module that reaches internal test support must still be refused. The release
 * identity must bind the repository's real lockfile (`bun.lock`).
 *
 * Small scratch fixtures exercise the rules; two cases read the real tree
 * (its build inputs, and its CLI graph) because the defect they pin is a
 * mismatch with that tree. Plain JavaScript on purpose: it imports the gate's
 * `.mjs` modules directly.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { BUILD_INPUT_FILES } from "../../scripts/build-public-release.mjs";
import { refusedModuleKind } from "../../scripts/public-boundary/artifact.mjs";
import { coreModuleEntries, coreModuleNames, releaseComposition } from "../../scripts/public-boundary/composition.mjs";
import { buildGraph, reach } from "../../scripts/public-boundary/graph.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ALL_KINDS = ["runtime", "dynamic", "type"];
const CORE = "@atomicstrata/llmwiki-core";

/** A minimal boundary manifest for scratch trees: one CLI entry, one core entry, one internal prefix. */
const MANIFEST = {
  publicRelease: { entries: { "root:cli": "src/cli.ts", "core:index": "src/core-index.ts" }, inRepositoryPackages: [CORE, "llm-wiki-compiler"] },
  packageEntries: { [CORE]: "src/core-index.ts" },
  publicPackages: [{ name: "llm-wiki-compiler", entries: ["root:cli"] }, { name: CORE, entries: ["core:index"] }],
  graph: { allowedConstructs: [] },
  internal: { prefixes: ["src/internal/"], modules: [] },
  internalProducts: { prefixes: [], coreEmbedded: { allocation: "pending-root-decision", modules: {} } },
};

/** The scratch source tree of the current case. */
let root;

/** Give each case of a suite its own scratch tree, removed afterwards. */
function useScratchTree() {
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "release-composition-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
}

/** Write fixture files: `{ "src/a.ts": "…" }`; `src/commands/` always exists, as in the repository. */
function write(files) {
  mkdirSync(path.join(root, "src", "commands"), { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
}

/** A CLI file that imports the given core module subpaths. */
const importing = (...names) => names.map((name) => `import "${CORE}/modules/${name}";`).join("\n");

describe("the core module set is derived once, from the CLI's own files", () => {
  useScratchTree();

  it("reads src/cli/* and src/commands/workflow*.ts, sorted, and ignores other command files", () => {
    write({ "src/cli/a.ts": importing("commands/ingest", "cli/shared"), "src/commands/workflow-run.ts": importing("utils/output"),
      "src/commands/other.ts": importing("commands/never"), "src/cli/shared.ts": "", "src/commands/ingest.ts": "", "src/utils/output.ts": "" });
    expect(coreModuleNames(root)).toEqual(["cli/shared", "commands/ingest", "utils/output"]);
    expect(Object.keys(coreModuleEntries(root))).toEqual(["modules/cli/shared", "modules/commands/ingest", "modules/utils/output"]);
    expect(coreModuleEntries(root)["modules/cli/shared"]).toBe(path.join(root, "src", "cli", "shared.ts"));
  });

  it("refuses a traversal, an absolute or a non-lower-case module name", () => {
    for (const name of ["../internal/host", "/etc/passwd", "commands/Ingest", "commands/ingest.js"]) {
      rmSync(path.join(root, "src"), { recursive: true, force: true });
      write({ "src/cli/a.ts": importing(name) });
      expect(() => coreModuleNames(root)).toThrow(/not plain lower-case path segments/);
    }
  });

  it("refuses a module name whose source file does not exist", () => {
    write({ "src/cli/a.ts": importing("commands/missing") });
    expect(() => coreModuleNames(root)).toThrow(/has no source file src\/commands\/missing\.ts/);
  });
});

describe("the release composition maps exactly the derived subpaths", () => {
  useScratchTree();

  /** A fixture CLI that lazily loads one command file importing one known core module. */
  function lazyCli(extra = {}) {
    write({ "src/cli.ts": 'export const load = () => import("./cli/a.js");', "src/cli/a.ts": importing("commands/ingest"),
      "src/commands/ingest.ts": 'import { helper } from "./helper.js"; export const ingest = helper;', "src/commands/helper.ts": "export const helper = 1;",
      "src/core-index.ts": "export const core = 1;", ...extra });
  }

  it("resolves a known module subpath to its source through the package, and predicts its closure", () => {
    lazyCli();
    const composition = releaseComposition(root, MANIFEST);
    expect(composition.packageEntries[`${CORE}/modules/commands/ingest`]).toBe("src/commands/ingest.ts");
    expect(composition.packages.find((entry) => entry.name === CORE).entries).toEqual(["core:index", "core:modules/commands/ingest"]);
    const built = buildGraph(root, composition.entries, composition.graphConfig);
    expect(built.problems).toEqual([]);
    const edge = built.graph.get("src/cli/a.ts").find((candidate) => candidate.target === "src/commands/ingest.ts");
    expect(edge.viaPackage).toBe(`${CORE}/modules/commands/ingest`);
    expect([...reach(built.graph, composition.entries["core:modules/commands/ingest"], ALL_KINDS, true).keys()]).toEqual(["src/commands/ingest.ts", "src/commands/helper.ts"]);
  });

  it("keeps an unknown module subpath unresolved: there is no wildcard mapping", () => {
    lazyCli({ "src/core-index.ts": `export { x } from "${CORE}/modules/commands/unknown";` });
    const composition = releaseComposition(root, MANIFEST);
    const built = buildGraph(root, composition.entries, composition.graphConfig);
    expect(built.problems).toEqual([expect.objectContaining({ module: "src/core-index.ts", specifier: `${CORE}/modules/commands/unknown`,
      reason: "relative or in-repository specifier resolves to no file" })]);
  });

  it("still refuses internal test support reached through a mapped module entry", () => {
    lazyCli({ "src/commands/helper.ts": 'export { host as helper } from "../internal/host.js";', "src/internal/host.ts": "export const host = 1;" });
    const composition = releaseComposition(root, MANIFEST);
    const built = buildGraph(root, composition.entries, composition.graphConfig);
    const reached = [...reach(built.graph, composition.entries["root:cli"], ALL_KINDS).keys()];
    expect(reached).toContain("src/internal/host.ts");
    expect(refusedModuleKind(MANIFEST, "src/internal/host.ts")).toBe("internal-test-support");
  });
});

describe("the real tree", () => {
  it("binds the repository's real lockfile and every build input exists", () => {
    expect(BUILD_INPUT_FILES).toContain("bun.lock");
    expect(BUILD_INPUT_FILES).toContain("scripts/public-boundary/composition.mjs");
    expect(BUILD_INPUT_FILES).not.toContain("package-lock.json");
    expect(BUILD_INPUT_FILES.filter((file) => !existsSync(path.join(REPO, file)))).toEqual([]);
  });

  it("resolves every per-module import the public CLI makes, and the core package exports ./modules/*", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO, "scripts/public-boundary/manifest.json"), "utf8"));
    const composition = releaseComposition(REPO, manifest);
    const built = buildGraph(REPO, composition.entries, composition.graphConfig);
    expect(built.problems.filter((problem) => String(problem.specifier).startsWith(`${CORE}/modules/`))).toEqual([]);
    expect(composition.moduleNames.length).toBeGreaterThan(0);
    const core = JSON.parse(readFileSync(path.join(REPO, "packages/llmwiki-core/package.json"), "utf8"));
    expect(core.exports["./modules/*"]).toBe("./dist/modules/*.js");
  });
});
