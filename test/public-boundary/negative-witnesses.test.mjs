/**
 * @file test/public-boundary/negative-witnesses.test.mjs
 * @description Witnesses that the public release gate REFUSES what it exists
 * to refuse. Each case builds a small contaminated fixture (a source tree, a
 * manifest, a shipped file, a release identity) and runs the gate's own
 * modules over it; none mirrors the real tree.
 *
 * Bypass classes covered: an internal module behind a re-export, a literal
 * dynamic import, a type-only edge and a literal `require`; module loading
 * the graph cannot follow (non-literal `import()`, `createRequire`,
 * `import x = require()`); a relative or in-repository specifier that
 * resolves to nothing; a missing entry; dependency ranges that are not plain
 * semver; a shipped file or source map that carries internal code; a stale
 * stage; and a manifest whose exports, dependencies or scripts differ from
 * the approved ones. Plain JavaScript on purpose: it imports the gate's `.mjs`
 * modules directly.
 */

import { symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { hashFindings, manifestFindings, scanShippedFile } from "../../scripts/public-boundary/artifact.mjs";
import { isPlainSemverRange, packageOf } from "../../scripts/public-boundary/dependencies.mjs";
import { parseFacade } from "../../scripts/public-boundary/facades.mjs";
import { buildGraph, reach } from "../../scripts/public-boundary/graph.mjs";
import { programCommandsOf, registeredToolsOf } from "../../scripts/public-boundary/surface.mjs";
import { scratchTreePerCase, writeTree } from "./scratch-tree.mjs";

const ALL_KINDS = ["runtime", "dynamic", "type"];
const CONFIG = { packageEntries: { "@fixture/core": "src/core.ts" }, inRepositoryPackages: ["@fixture/core"], allowedConstructs: [] };

/** A boundary manifest with one internal test-support module and one unallocated product prefix. */
const BOUNDARY = {
  internal: { prefixes: ["src/internal/"], modules: ["src/host.ts"], forbiddenSymbols: ["startSimulatedHost"] },
  internalProducts: { prefixes: ["src/product/"], coreEmbedded: { allocation: "pending-root-decision", modules: { "src/product/embedded.ts": {} } } },
  publicDependencies: { releaseVersion: "2.0.0", packages: { pkg: { dependencies: { commander: "^13.0.0" } } } },
};
const APPROVED = { exports: { ".": "./dist/index.js" }, bin: { tool: "dist/cli.js" }, files: ["dist"] };

/** The scratch source tree of the current graph case. */
let root;

/** Give each case of a suite its own scratch tree, removed afterwards. */
function useScratchTree() {
  scratchTreePerCase("boundary-witness-", (created) => { root = created; });
}

/** Write fixture modules: `{ "src/a.ts": "…" }`. */
function write(files) {
  writeTree(root, files);
}

/** Modules reachable from `src/entry.ts`, and the problems found on the way. */
function analyse(config = CONFIG) {
  const built = buildGraph(root, { entry: "src/entry.ts" }, config);
  return { reached: [...reach(built.graph, "src/entry.ts", ALL_KINDS).keys()], runtime: [...reach(built.graph, "src/entry.ts", ["runtime", "dynamic"]).keys()], problems: built.problems };
}

describe("the import graph follows every edge kind", () => {
  useScratchTree();

  it("reaches an internal module hidden behind a re-export chain", () => {
    write({ "src/entry.ts": 'export { a } from "./a.js";', "src/a.ts": 'export * from "./internal/secret.js"; export const a = 1;', "src/internal/secret.ts": "export const s = 1;" });
    expect(analyse().runtime).toContain("src/internal/secret.ts");
  });

  it("reaches an internal module through a literal dynamic import and a literal require", () => {
    write({ "src/entry.ts": 'export const load = () => import("./internal/dyn.js"); const x = require("./internal/req.js");', "src/internal/dyn.ts": "export {};", "src/internal/req.ts": "export {};" });
    expect(analyse().runtime).toEqual(expect.arrayContaining(["src/internal/dyn.ts", "src/internal/req.ts"]));
  });

  it("reaches an internal module through a type-only edge, and keeps it out of the runtime set", () => {
    write({ "src/entry.ts": 'import type { T } from "./internal/types.js"; export type U = import("./internal/inline.js").V; export const x: T | null = null;',
      "src/internal/types.ts": "export interface T {}", "src/internal/inline.ts": "export interface V {}" });
    const result = analyse();
    expect(result.reached).toEqual(expect.arrayContaining(["src/internal/types.ts", "src/internal/inline.ts"]));
    expect(result.runtime).not.toContain("src/internal/types.ts");
  });

  it("follows an in-repository package specifier to its source entry", () => {
    write({ "src/entry.ts": 'export { c } from "@fixture/core";', "src/core.ts": 'export { c } from "./internal/core-secret.js";', "src/internal/core-secret.ts": "export const c = 1;" });
    expect(analyse().runtime).toContain("src/internal/core-secret.ts");
  });

});

describe("the import graph refuses what it cannot follow", () => {
  useScratchTree();

  it.each([
    ["a non-literal dynamic import", 'const name = "./x.js"; export const load = () => import(name);', "dynamic-import"],
    ["a non-literal require", "const name = process.argv[2]; export const loaded = require(name);", "require"],
    ["createRequire", 'import { createRequire } from "node:module"; export const r = createRequire(import.meta.url);', "createRequire"],
    ["createRequire under another name", 'import { createRequire as load } from "node:module"; export const r = load(import.meta.url);', "createRequire"],
    ["the module namespace that carries createRequire", 'import * as nodeModule from "node:module"; export const r = nodeModule.createRequire(import.meta.url);', "createRequire"],
    ["import-equals require", 'import fs = require("node:fs"); export { fs };', "import-equals-require"],
  ])("reports %s as a problem", (_label, text, construct) => {
    write({ "src/entry.ts": text });
    expect(analyse().problems).toEqual([expect.objectContaining({ module: "src/entry.ts", construct })]);
  });

  it("reports a relative specifier and an in-repository subpath that resolve to nothing", () => {
    write({ "src/entry.ts": 'import "./missing.js"; export { z } from "@fixture/core/unknown-subpath";' });
    expect(analyse().problems.map((problem) => problem.specifier).sort()).toEqual(["./missing.js", "@fixture/core/unknown-subpath"]);
  });

  it("refuses a relative import that escapes the repository root", () => {
    const project = path.join(root, "project");
    write({ "project/src/entry.ts": 'import { secret } from "../../private.js"; export const x = secret;', "private.ts": 'export const secret = "outside";' });
    const built = buildGraph(project, { entry: "src/entry.ts" }, CONFIG);
    expect(built.problems).toEqual([expect.objectContaining({ module: "src/entry.ts", specifier: "../../private.js", reason: "relative or in-repository specifier resolves to no file" })]);
    expect(built.graph.has("../private.ts")).toBe(false);
  });

  it("refuses a source symlink to a file outside the repository root", () => {
    const project = path.join(root, "project");
    write({ "project/src/entry.ts": 'import { secret } from "./link.js"; export const x = secret;', "private.ts": 'export const secret = "outside";' });
    symlinkSync(path.join(root, "private.ts"), path.join(project, "src", "link.ts"));
    const built = buildGraph(project, { entry: "src/entry.ts" }, CONFIG);
    expect(built.problems).toEqual([expect.objectContaining({ module: "src/entry.ts", specifier: "./link.js", reason: "relative or in-repository specifier resolves to no file" })]);
    expect(built.graph.has("src/link.ts")).toBe(false);
  });

  it("reports a missing entry instead of treating it as reaching nothing", () => {
    expect(buildGraph(root, { entry: "src/absent.ts" }, CONFIG).problems).toEqual([expect.objectContaining({ construct: "entry", module: "src/absent.ts" })]);
  });

  it("admits a construct only for the exact file, construct and expression an allowlist entry names", () => {
    const binding = 'import { createRequire } from "node:module";';
    write({ "src/entry.ts": `${binding} export const r = createRequire(import.meta.url); export * from "./other.js";`, "src/other.ts": `${binding} export const o = 1;` });
    const allowed = { ...CONFIG, allowedConstructs: [{ file: "src/entry.ts", construct: "createRequire", expression: binding, reason: "fixture" }] };
    expect(analyse(allowed).problems).toEqual([expect.objectContaining({ module: "src/other.ts", construct: "createRequire" })]);
  });

  it("still reports a second, different unfollowable expression in a file that has an allowlisted one", () => {
    write({ "src/entry.ts": "export const a = () => import(first); export const b = () => import(second);" });
    const allowed = { ...CONFIG, allowedConstructs: [{ file: "src/entry.ts", construct: "dynamic-import", expression: "import(first)", reason: "fixture" }] };
    expect(analyse(allowed).problems).toEqual([expect.objectContaining({ construct: "dynamic-import", expression: "import(second)" })]);
  });
});

describe("dependency ranges and names", () => {
  it.each(["^1.2.3", "1.4.1", "~0.3.0", ">=1 <2", "^3.1154.0", "1.x".replace("x", "0"), "^1.0.0 || ^2.0.0"])("accepts the plain semver range %s", (range) => {
    expect(isPlainSemverRange(range)).toBe(true);
  });

  it.each(["npm:other@^1.0.0", "git+https://example.invalid/a/b.git", "https://example.invalid/a.tgz", "github:user/repo", "user/repo",
    "file:../local", "link:../local", "workspace:*", "latest", "*", "", "^1.2.3 || npm:x@1", undefined])("refuses the range %s", (range) => {
    expect(isPlainSemverRange(range)).toBe(false);
  });

  it("names the package behind a specifier and ignores Node built-ins", () => {
    expect(packageOf("@scope/name/sub/path.js")).toBe("@scope/name");
    expect(packageOf("commander/esm.mjs")).toBe("commander");
    expect(packageOf("node:fs")).toBeNull();
    expect(packageOf("fs/promises")).toBeNull();
  });
});

describe("the artifact scan and the release identity", () => {
  it("refuses a shipped file that carries an internal symbol", () => {
    expect(scanShippedFile(BOUNDARY, "dist/chunk.js", "export function startSimulatedHost() {}")).toEqual([expect.objectContaining({ kind: "forbidden-symbol" })]);
    expect(scanShippedFile(BOUNDARY, "dist/index.d.ts", "export declare function startSimulatedHost(): void;")).toHaveLength(1);
    expect(scanShippedFile(BOUNDARY, "dist/index.js", "export function openProject() {}")).toEqual([]);
  });

  it("refuses a source map that names internal test support or an unallocated product module, and marks a pending one", () => {
    const map = (sources) => JSON.stringify({ sources, sourcesContent: sources.map(() => "x") });
    expect(scanShippedFile(BOUNDARY, "a.js.map", map(["../../src/internal/cli.ts", "../../src/host.ts"])))
      .toEqual([expect.objectContaining({ kind: "source-map-names-internal-test-support-module", embedsContent: true, modules: ["src/host.ts", "src/internal/cli.ts"] })]);
    expect(scanShippedFile(BOUNDARY, "b.js.map", map(["../../src/product/feature.ts"]))).toEqual([expect.objectContaining({ kind: "source-map-names-internal-product-module" })]);
    expect(scanShippedFile(BOUNDARY, "c.js.map", map(["../../src/product/embedded.ts"]))).toEqual([expect.objectContaining({ kind: "source-map-names-pending-root-decision-module" })]);
    expect(scanShippedFile(BOUNDARY, "d.js.map", map(["../../src/ordinary.ts"]))).toEqual([]);
  });

  it("refuses a stage whose recorded sources or files no longer match", () => {
    const recorded = { "src/a.ts": "hash-a", "src/b.ts": "hash-b" };
    expect(hashFindings("source", recorded, recorded)).toEqual([]);
    expect(hashFindings("source", recorded, { "src/a.ts": "edited", "src/c.ts": "hash-c" }).map((finding) => `${finding.kind}:${finding.file}`).sort())
      .toEqual(["source-changed:src/a.ts", "source-missing:src/b.ts", "source-not-in-identity:src/c.ts"]);
  });

  it("refuses a staged manifest that differs from the approved maps, allowlist, version or publishing rules", () => {
    const good = { name: "pkg", version: "2.0.0", ...APPROVED, dependencies: { commander: "^13.0.0" } };
    expect(manifestFindings(BOUNDARY, APPROVED, good)).toEqual([]);
    const kindsOf = (changed) => manifestFindings(BOUNDARY, APPROVED, { ...good, ...changed }).map((finding) => finding.kind);
    expect(kindsOf({ exports: { ...APPROVED.exports, "./internal": "./dist/internal.js" } })).toEqual(["exports-map-differs-from-approved"]);
    expect(kindsOf({ dependencies: { commander: "npm:other@^13.0.0" } })).toEqual(["dependencies-differ-from-allowlist"]);
    expect(kindsOf({ dependencies: { ...good.dependencies, extra: "^1.0.0" } })).toEqual(["dependencies-differ-from-allowlist"]);
    expect(kindsOf({ peerDependencies: { extra: "^1.0.0" } })).toEqual(["peerDependencies-differ-from-allowlist"]);
    expect(kindsOf({ version: "1.9.9" })).toEqual(["version-differs-from-release-version"]);
    expect(kindsOf({ private: true })).toEqual(["public-package-is-private"]);
    expect(kindsOf({ scripts: { postinstall: "node x.js" } })).toEqual(["lifecycle-script-present"]);
    expect(kindsOf({ files: ["dist", "src"] })).toEqual(["files-list-differs-from-approved"]);
  });
});

describe("facade and registration reading", () => {
  it("reports every export form a facade may not contain", () => {
    const { statements, unsupported } = parseFacade('export { a, type B } from "./a.js";\nexport * as ns from "./n.js";\nexport const local = 1;\nexport default 2;\nexport { loose };\n');
    expect(statements.map((statement) => statement.elements.map((element) => element.name))).toEqual([["a", "B"], ["ns"]]);
    expect(unsupported).toHaveLength(3);
  });

  it("reads commands and tools from call expressions, not from text that merely mentions them", () => {
    const text = 'program\n  .command("alpha <x>");\naddOption(program.command("beta"));\n// program.command("in-comment")\nconst s = \'program.command("in-string")\';\nother.command("not-program");';
    expect(programCommandsOf(text)).toEqual(["alpha", "beta"]);
    expect(registeredToolsOf('server.registerTool("tool_a", {});\n// registerTool("commented")')).toEqual(["tool_a"]);
  });
});
