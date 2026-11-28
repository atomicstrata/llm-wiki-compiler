/**
 * @file test/public-boundary/on-demand-loads.test.mjs
 * @description Witnesses for the import graph's handling of the canonical
 * on-demand loader (`requireOnUse` in `src/utils/require-on-use.ts`,
 * `scripts/public-boundary/on-demand-loads.mjs`) and of source-hash pinned
 * allowlist entries (`scripts/public-boundary/graph.mjs`).
 *
 * The loader hides its loads behind `createRequire`, so the graph must read
 * them at the callers:
 * - every supported literal call is a runtime outside package or edge,
 *   resolved from the LOADER's location;
 * - every form that could hide a load is a problem no allowlist entry admits;
 * - a same-named function has no loader authority.
 *
 * The loader's and the kernel helper's own `createRequire` bindings are
 * admitted only by an entry carrying the exact module hash. An omitted, invalid
 * or different hash, or a changed module, admits nothing. The other modules
 * keep the legacy file/construct/expression rule.
 *
 * The last case runs the dependency check over a lazily loaded package missing
 * from the allowlist.
 *
 * Every case builds a small scratch source tree and runs the gate's own modules
 * over it. No application, native or model code is imported or executed. Plain
 * JavaScript on purpose: it imports the gate's `.mjs` modules directly.
 */

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { checkDependencies } from "../../scripts/public-boundary/dependencies.mjs";
import { buildGraph, reach } from "../../scripts/public-boundary/graph.mjs";
import { scratchTreePerCase, writeTree } from "./scratch-tree.mjs";

/** The canonical loader module and the scratch entry that imports every caller. */
const LOADER = "src/utils/require-on-use.ts";
const KERNEL = "src/utils/kernel-start-time.ts";
const ENTRY = "src/entry.ts";

/** Scratch module texts of the loader and the kernel helper (shaped like the real ones). */
const LOADER_TEXT = 'import { createRequire } from "node:module";\nconst nodeRequire = createRequire(import.meta.url);\nexport function requireOnUse(specifier) {\n  return nodeRequire(specifier);\n}\n';
const KERNEL_TEXT = 'import { createRequire } from "node:module";\nexport function bindSysctl() {\n  return createRequire(import.meta.url)("bun:ffi");\n}\n';
const BINDING = 'import { createRequire } from "node:module";';

/** The import of the loader written from a module in `src/<dir>/`. */
const IMPORT = 'import { requireOnUse } from "../utils/require-on-use.js";\n';

/** Hex SHA-256 of a text's UTF-8 bytes (what the graph hashes after reading the file). */
const sha = (text) => createHash("sha256").update(text).digest("hex");

/** An allowlist entry for the exact `createRequire` binding of `file`, with optional extra fields (such as `sourceSha256`). */
const binding = (file, extra = {}) => ({ file, construct: "createRequire", expression: BINDING, reason: "witness", ...extra });

/** The scratch source tree of the current case. */
let root;

/** Give each case of a suite its own scratch tree, removed afterwards. */
function useScratchTree() {
  scratchTreePerCase("on-demand-loads-", (created) => { root = created; });
}

/** Write fixture modules: `{ "src/a.ts": "…" }`. */
function write(files) {
  writeTree(root, files);
}

/** Build the graph from an entry importing `callers` (`{ "src/x/a.ts": text }`), with the loader in place and the given allowlist. */
function graphOf(callers, allowed = [binding(LOADER, { sourceSha256: sha(LOADER_TEXT) })], extra = {}) {
  const imports = Object.keys(callers).map((file) => `import "./${path.posix.relative("src", file).replace(/\.ts$/u, ".js")}";`).join("\n");
  write({ [LOADER]: LOADER_TEXT, [ENTRY]: imports, ...callers, ...extra });
  return buildGraph(root, { entry: ENTRY }, { packageEntries: {}, inRepositoryPackages: [], allowedConstructs: allowed });
}

/** The outside packages one module loads at run time, sorted. */
const runtimeExternals = (built, module) => (built.externals.get(module) ?? []).filter((item) => item.kind === "runtime").map((item) => item.specifier).sort();

/** The reasons of the problems one module produced. */
const reasons = (built, module) => built.problems.filter((problem) => problem.module === module).map((problem) => problem.reason);

describe("the canonical on-demand loader's callers are followed", () => {
  useScratchTree();

  it("counts every current call form: six literal loads in five modules become runtime outside packages", () => {
    const built = graphOf({
      "src/compiler/extraction-snapshot.ts": `${IMPORT}export const z = () => requireOnUse<typeof import("zod")>("zod").z;\n`,
      "src/compiler/link-repair-code.ts": `${IMPORT}export const parse = (html) => new (requireOnUse<typeof MarkdownIt>("markdown-it"))({ html });\n`,
      "src/providers/openai.ts": `${IMPORT}export const client = () => requireOnUse<typeof import("openai")>("openai").default;\n`,
      "src/viewer/render.ts": `${IMPORT}export const s = () => requireOnUse<typeof sanitizeHtml>("sanitize-html");\nexport const p = () => requireOnUse<typeof MarkdownIt>("markdown-it");\n`,
      "src/wiki/wikilink-tokens.ts": `${IMPORT}export const t = () => requireOnUse<typeof MarkdownIt>("markdown-it");\n`,
    });
    expect(built.problems).toEqual([]);
    expect(runtimeExternals(built, "src/compiler/extraction-snapshot.ts")).toEqual(["zod"]);
    expect(runtimeExternals(built, "src/compiler/link-repair-code.ts")).toEqual(["markdown-it"]);
    expect(runtimeExternals(built, "src/providers/openai.ts")).toEqual(["openai"]);
    expect(runtimeExternals(built, "src/viewer/render.ts")).toEqual(["markdown-it", "sanitize-html"]);
    expect(runtimeExternals(built, "src/wiki/wikilink-tokens.ts")).toEqual(["markdown-it"]);
  });

  it("follows an aliased named import and a template literal without substitutions", () => {
    const built = graphOf({ "src/feature/a.ts": 'import { requireOnUse as load } from "../utils/require-on-use.js";\nexport const x = () => [load("zod"), load(`openai`)];\n' });
    expect(built.problems).toEqual([]);
    expect(runtimeExternals(built, "src/feature/a.ts")).toEqual(["openai", "zod"]);
  });

  it("resolves a relative load from the loader's location and keeps a private target reachable", () => {
    const built = graphOf({ "src/feature/a.ts": `${IMPORT}export const x = () => requireOnUse("../internal/secret.js");\n` }, undefined, { "src/internal/secret.ts": "export const secret = 1;\n" });
    expect(built.problems).toEqual([]);
    expect(built.graph.get("src/feature/a.ts")).toContainEqual({ target: "src/internal/secret.ts", kind: "runtime", viaPackage: null, names: ["*"] });
    expect([...reach(built.graph, ENTRY, ["runtime", "dynamic"]).keys()]).toContain("src/internal/secret.ts");
  });

  it("refuses a relative load that only resolves from the caller's own directory", () => {
    const built = graphOf({ "src/feature/a.ts": `${IMPORT}export const x = () => requireOnUse("./sibling.js");\n` }, undefined, { "src/feature/sibling.ts": "export const s = 1;\n" });
    expect(reasons(built, "src/feature/a.ts")).toEqual(["on-demand load resolves to no file from the loader's location"]);
  });

  it("gives no loader authority to a same-named function or a same-named import from another module", () => {
    const built = graphOf({
      "src/feature/local.ts": 'function requireOnUse(name) { return name; }\nexport const x = requireOnUse("ghost-local");\n',
      "src/feature/other.ts": 'import { requireOnUse } from "./impostor.js";\nexport const y = requireOnUse("ghost-imported");\n',
    }, undefined, { "src/feature/impostor.ts": "export function requireOnUse(name) { return name; }\n" });
    expect(built.problems).toEqual([]);
    expect(runtimeExternals(built, "src/feature/local.ts")).toEqual([]);
    expect(runtimeExternals(built, "src/feature/other.ts")).toEqual([]);
  });
});

/** Caller bodies (after the loader import) whose use of the loader could hide a load, and the refusal each must produce. */
const REFUSED_CALLS = [
  ["a non-literal specifier", "export const x = (name) => requireOnUse(name);", "non-literal on-demand load specifier"],
  ["a template literal with a substitution", "export const x = (name) => requireOnUse(`pkg-${name}`);", "non-literal on-demand load specifier"],
  ["a second argument", 'export const x = () => requireOnUse("zod", 1);', "the on-demand loader must be called with exactly one argument"],
  ["no argument", "export const x = () => requireOnUse();", "the on-demand loader must be called with exactly one argument"],
  ["a spread argument", "export const x = (names) => requireOnUse(...names);", "spread argument to the on-demand loader"],
  ["an optional call", 'export const x = () => requireOnUse?.("zod");', "optional call of the on-demand loader"],
  ["an absolute specifier", 'export const x = () => requireOnUse("/etc/module.js");', "empty or absolute on-demand load specifier"],
  ["an empty specifier", 'export const x = () => requireOnUse("");', "empty or absolute on-demand load specifier"],
  ["the loader passed as a value", "export const x = (run) => run(requireOnUse);", "the on-demand loader is used other than as a direct call"],
  ["the loader stored under another name", "const load = requireOnUse;\nexport const x = () => load(\"zod\");", "the on-demand loader is used other than as a direct call"],
  ["the binding reassigned", "requireOnUse = null;", "the on-demand loader is used other than as a direct call"],
  ["the binding re-exported locally", "export { requireOnUse };", "the on-demand loader is used other than as a direct call"],
  ["a parenthesised callee", 'export const x = () => (requireOnUse)("zod");', "the on-demand loader is used other than as a direct call"],
  ["the binding shadowed by a parameter", 'export function x(requireOnUse) { return requireOnUse("zod"); }', "the on-demand loader binding is shadowed or redeclared"],
];

/** Whole caller modules whose access to the loader module could hide a load, and the refusal each must produce. */
const REFUSED_ACCESS = [
  ["a namespace import", 'import * as loader from "../utils/require-on-use.js";\nexport const x = () => loader.requireOnUse("zod");', "namespace import of the on-demand loader module"],
  ["a default import", 'import loader from "../utils/require-on-use.js";\nexport const x = loader;', "default import of the on-demand loader module"],
  ["a named re-export", 'export { requireOnUse } from "../utils/require-on-use.js";', "re-export from the on-demand loader module"],
  ["a star re-export", 'export * from "../utils/require-on-use.js";', "re-export from the on-demand loader module"],
  ["a literal dynamic import", 'export const x = () => import("../utils/require-on-use.js");', "dynamic import() or require() of the on-demand loader module"],
  ["a literal require", 'export const x = () => require("../utils/require-on-use.js");', "dynamic import() or require() of the on-demand loader module"],
];

describe("every use of the loader that could hide a load is refused", () => {
  useScratchTree();

  it.each(REFUSED_CALLS)("refuses %s", (_form, body, reason) => {
    expect(reasons(graphOf({ "src/feature/a.ts": `${IMPORT}${body}\n` }), "src/feature/a.ts")).toContain(reason);
  });

  it.each(REFUSED_ACCESS)("refuses %s of the loader module", (_form, text, reason) => {
    expect(reasons(graphOf({ "src/feature/a.ts": `${text}\n` }), "src/feature/a.ts")).toContain(reason);
  });

  it("does not let an allowlist entry admit a refused loader use", () => {
    const allowed = [binding(LOADER, { sourceSha256: sha(LOADER_TEXT) }), { file: "src/feature/a.ts", construct: "require-on-use", expression: "requireOnUse(name)", reason: "witness" }];
    const built = graphOf({ "src/feature/a.ts": `${IMPORT}export const x = (name) => requireOnUse(name);\n` }, allowed);
    expect(reasons(built, "src/feature/a.ts")).toEqual(["non-literal on-demand load specifier"]);
  });
});

/** Every way a hash-pinned entry can fail, as a function of the module text: the entry's extra fields and the text actually written. */
const HASH_VARIANTS = [
  ["an omitted hash", () => ({}), (text) => text],
  ["a non-hex hash", () => ({ sourceSha256: "not-a-sha256" }), (text) => text],
  ["an upper-case hash", (text) => ({ sourceSha256: sha(text).toUpperCase() }), (text) => text],
  ["the hash of different bytes", () => ({ sourceSha256: sha("other bytes") }), (text) => text],
  ["a changed module under the original hash", (text) => ({ sourceSha256: sha(text) }), (text) => `${text}// changed\n`],
];

/** The two hash-pinned modules, each with its scratch text. */
const PINNED = [["the loader", LOADER, LOADER_TEXT], ["the kernel helper", KERNEL, KERNEL_TEXT]];

/** Every pinned module crossed with every failing hash variant. */
const PINNED_FAILURES = PINNED.flatMap(([who, file, text]) => HASH_VARIANTS.map(([variant, fields, written]) => [`${who} with ${variant}`, file, text, fields, written]));

/** Graph of an entry importing only `file` (written as `text`), with one `createRequire` entry for it. */
function pinnedGraph(file, text, entry) {
  write({ [file]: text, [ENTRY]: `import "./${path.posix.relative("src", file).replace(/\.ts$/u, ".js")}";\n` });
  return buildGraph(root, { entry: ENTRY }, { packageEntries: {}, inRepositoryPackages: [], allowedConstructs: [entry] });
}

describe("hash-pinned exceptions admit only the exact reviewed module", () => {
  useScratchTree();

  it("admits the loader's and the kernel helper's createRequire binding with the exact module hash", () => {
    for (const [, file, text] of PINNED) {
      rmSync(path.join(root, "src"), { recursive: true, force: true });
      expect(pinnedGraph(file, text, binding(file, { sourceSha256: sha(text) })).problems).toEqual([]);
    }
  });

  it.each(PINNED_FAILURES)("refuses %s", (_case, file, text, fields, written) => {
    const built = pinnedGraph(file, written(text), binding(file, fields(text)));
    expect(built.problems).toEqual([expect.objectContaining({ module: file, construct: "createRequire", reason: "module loading the graph cannot follow" })]);
  });

  it("keeps the legacy rule elsewhere: no hash still admits the exact expression, a wrong hash does not", () => {
    const file = "src/cli/environment.ts";
    expect(pinnedGraph(file, `${BINDING}\nexport const r = 1;\n`, binding(file)).problems).toEqual([]);
    rmSync(path.join(root, "src"), { recursive: true, force: true });
    expect(pinnedGraph(file, `${BINDING}\nexport const r = 1;\n`, binding(file, { sourceSha256: sha("other bytes") })).problems).toHaveLength(1);
  });

  it("still refuses an ordinary unfollowable construct (fail-closed regression)", () => {
    write({ [ENTRY]: `${BINDING}\nexport const load = (name) => import(name);\n` });
    const built = buildGraph(root, { entry: ENTRY }, { packageEntries: {}, inRepositoryPackages: [], allowedConstructs: [] });
    expect(built.problems.map((problem) => problem.reason).sort()).toEqual(["module loading the graph cannot follow", "non-literal specifier"]);
  });
});

describe("the dependency check sees on-demand loads", () => {
  useScratchTree();

  it("reports a lazily loaded package missing from the allowlist, and accepts an allowlisted one", () => {
    write({ [LOADER]: LOADER_TEXT, "src/cli/.keep": "", "src/commands/.keep": "",
      "src/core.ts": `${IMPORT.replace("../utils", "./utils")}export const a = () => requireOnUse("zod");\nexport const b = () => requireOnUse("left-pad");\n` });
    const manifest = {
      publicRelease: { entries: { "core:index": "src/core.ts" }, inRepositoryPackages: ["@fixture/core"] },
      packageEntries: { "@fixture/core": "src/core.ts" },
      publicPackages: [{ name: "@fixture/core", entries: ["core:index"] }],
      graph: { allowedConstructs: [binding(LOADER, { sourceSha256: sha(LOADER_TEXT) })] },
      publicDependencies: { releaseVersion: "2.0.0", baselineVersion: "1.0.0", packages: { "@fixture/core": { dependencies: { zod: "^4.0.0" } } },
        approvedAdditions: [{ package: "@fixture/core", field: "dependencies", name: "zod", range: "^4.0.0", reason: "witness" }] },
    };
    const result = checkDependencies(root, manifest, { packages: { "@fixture/core": {} } });
    expect(result.findings).toEqual([{ package: "@fixture/core", kind: "imported-package-not-in-allowlist", name: "left-pad", edge: "runtime", from: "src/core.ts" }]);
    expect(result.passed).toBe(false);
    expect(result.packages[0].declaredButNotImported).toEqual([]);
  });
});
