/**
 * @file test/public-boundary/shape-witnesses.test.mjs
 * @description Witnesses that the release gate's SHAPE check fails on a real
 * API break even when a `unique symbol` brand sits in the same type, and that
 * it does not pass a brand or a class identity it cannot match. Each case
 * builds two small source trees (a baseline and a candidate) and runs the
 * gate's own comparison over them; none mirrors the real tree. The REVERSE
 * cases prove a narrowed type (a newly required member, a narrowed union, an
 * added brand, a removed optional member) fails, an optional addition passes,
 * and a named library-owned output type may add exactly its listed members
 * and nothing else, only on its own facade, and only when its policy is
 * proven against the declarations (otherwise it is rejected). Plain
 * JavaScript on purpose: it imports the gate's `.mjs` modules directly.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { brandDeclarationsOf, unifyBrandText } from "../../scripts/public-boundary/brands.mjs";
import { compareShapes } from "../../scripts/public-boundary/shapes.mjs";

const MANIFEST = {
  publicRelease: { stageDir: ".public-release/stage" }, packageEntries: {},
  surface: { facades: { core: { internal: "src/core-index.ts", public: "src/core-index.ts" }, root: { internal: "src/index.ts", public: "src/index.ts" } } },
};
const NAMES = ["EntityId", "Wiki", "createWiki", "Session"];
const EXPORTS = { core: NAMES, root: NAMES };
const FACADE = `export { createWiki, Session } from "./types.js";\nexport type { EntityId, Wiki } from "./types.js";\n`;
const BRAND = "export type EntityId = string & { readonly __entityId: unique symbol };";
const CLASS = "export declare class Session { private token: string; close(): void }";
/** The baseline module: a member brand, a branded field beside plain ones, a function and a class with a private member. */
const TYPES = [
  BRAND,
  "export interface Wiki { id: EntityId; count: number; open(name: string): Promise<EntityId> }",
  "export declare function createWiki(id: EntityId): Wiki;",
  CLASS,
].join("\n");

/** The fixture with its private-member class replaced by a plain value, so an edited module carries no class identity of its own. */
const PLAIN = TYPES.replace(CLASS, "export declare const Session: { close(): void };");

/** Write one tree: both facades and its `types.ts`. */
function writeTree(dir, types) {
  mkdirSync(path.join(dir, "src"), { recursive: true });
  for (const [file, text] of Object.entries({ "src/core-index.ts": FACADE, "src/index.ts": FACADE, "src/types.ts": types })) writeFileSync(path.join(dir, file), text);
}

/** Two scratch trees for one case, the comparison over them, and their removal. */
function shapeFixture() {
  const baselineDir = mkdtempSync(path.join(os.tmpdir(), "shape-baseline-"));
  const root = mkdtempSync(path.join(os.tmpdir(), "shape-candidate-"));
  return {
    /** Compare a candidate `types.ts` with a baseline's (by default the full fixture), optionally under named output policies. */
    compare(candidateTypes, baselineTypes = TYPES, libraryOutputTypes = []) {
      writeTree(baselineDir, baselineTypes);
      writeTree(root, candidateTypes);
      const manifest = { ...MANIFEST, surface: { ...MANIFEST.surface, shapePolicies: { libraryOutputTypes } } };
      return compareShapes(root, manifest, baselineDir, EXPORTS);
    },
    remove() { for (const dir of [baselineDir, root]) rmSync(dir, { recursive: true, force: true }); },
  };
}

/** The distinct kinds and names a result's findings carry for the core facade. */
function coreFindings(result) {
  return [...new Set(result.findings.filter((finding) => finding.facade === "core").map((finding) => `${finding.kind}:${finding.name}`))].sort();
}

/** The distinct directions and names of a result's findings for one facade (core by default). */
function coreDirections(result, facade = "core") {
  return [...new Set(result.findings.filter((finding) => finding.facade === facade).map((finding) => `${finding.direction}:${finding.name}`))].sort();
}

/** A valid output policy for the fixture's `Wiki` on one facade, with any field overridden. */
function policyFor(facade, overrides = {}) {
  return { facade, name: "Wiki", declaration: { module: "src/types.ts", name: "Wiki" }, reason: "only createWiki constructs it", allowedAdditions: ["added"], ...overrides };
}

describe("the shape check compares structure with matched brands unified", () => {
  let fixture;
  beforeEach(() => { fixture = shapeFixture(); });
  afterEach(() => { fixture.remove(); });

  it("passes an edited module whose branded types are unchanged, without discarding anything", () => {
    const withoutClass = TYPES.replace(CLASS, "export declare const Session: { close(): void };");
    const result = fixture.compare(`// edited, so the module is compared as two copies\n${withoutClass}`, withoutClass);
    expect(result.unchangedModules).toBe(0);
    expect(result.unifiedBrands).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("fails on a nested field break that sits beside a shared brand", () => {
    const result = fixture.compare(TYPES.replace("count: number", "count: string"));
    expect(result.unifiedBrands).toBe(1);
    expect(coreFindings(result)).toEqual(expect.arrayContaining(["shape:Wiki", "shape:createWiki"]));
    expect(coreFindings(result)).not.toContain("shape:EntityId");
  });

  it("fails on a signature break that sits beside a shared brand", () => {
    const result = fixture.compare(TYPES.replace("createWiki(id: EntityId): Wiki", "createWiki(id: EntityId, required: number): Wiki"));
    expect(coreFindings(result)).toContain("shape:createWiki");
    expect(result.passed).toBe(false);
  });

  it("treats a byte-identical tree as one set of declarations", () => {
    const result = fixture.compare(TYPES);
    expect(result.passed).toBe(true);
    expect(result.unchangedModules).toBe(3);
  });
});

describe("the shape check never passes an identity it cannot match", () => {
  let fixture;
  beforeEach(() => { fixture = shapeFixture(); });
  afterEach(() => { fixture.remove(); });

  it.each([
    ["removed", "export type EntityId = string;"],
    ["renamed", "export type EntityId = string & { readonly __entityIdV2: unique symbol };"],
    ["changed to another form", "declare const entityBrand: unique symbol;\nexport type EntityId = string & { readonly [entityBrand]: true };"],
  ])("fails when the brand is %s", (_label, declaration) => {
    const result = fixture.compare(TYPES.replace(BRAND, declaration));
    expect(result.unifiedBrands).toBe(0);
    expect(coreFindings(result)).toContain("shape:EntityId");
    expect(result.passed).toBe(false);
  });

  it("reports a class with private members in a changed module as unverified, never as a pass", () => {
    const result = fixture.compare(`// edited\n${TYPES}`);
    expect(coreFindings(result)).toEqual(["nominal-declaration-unverified:Session"]);
    expect(result.passed).toBe(false);
  });
});

describe("a brand that moved between owners is not the same brand", () => {
  let fixture;
  beforeEach(() => { fixture = shapeFixture(); });
  afterEach(() => { fixture.remove(); });

  /** A module whose facade names are all present, with the brand on `owner` and the other alias plain. */
  const swapped = (owner) => [
    owner === "EntityId" ? BRAND : "export type EntityId = string;",
    `export type Wiki = ${owner === "Wiki" ? "string & { readonly __entityId: unique symbol }" : "string"};`,
    "export declare function createWiki(id: EntityId): Wiki;",
    "export declare const Session: { close(): void };",
  ].join("\n");

  it("fails when a same-name brand is swapped from one type alias to another in the same file", () => {
    const result = fixture.compare(swapped("Wiki"), swapped("EntityId"));
    expect(result.unifiedBrands).toBe(0);
    expect(result.brandsOnlyInOneTree.map((entry) => `${entry.only}: ${entry.brand}`).sort()).toEqual(["baseline: member | type EntityId | __entityId", "candidate: member | type Wiki | __entityId"]);
    expect(coreFindings(result)).toEqual(expect.arrayContaining(["shape:EntityId", "shape:Wiki"]));
    expect(result.passed).toBe(false);
  });

  it("unifies the brand when it stays on the same owner", () => {
    const result = fixture.compare(`// edited\n${swapped("Wiki")}`, swapped("Wiki"));
    expect(result.unifiedBrands).toBe(1);
    expect(result.passed).toBe(true);
  });
});

describe("brand declarations are read from the syntax tree, not from text", () => {
  const keys = (text) => brandDeclarationsOf(text).map((declaration) => declaration.key);

  it.each([
    ["a block comment", "/* readonly phantom: unique symbol */"],
    ["a line comment", "// declare const phantom: unique symbol;"],
    ["a string", 'const text = "readonly phantom: unique symbol";'],
    ["a template literal", "const text = `declare const phantom: unique symbol;\nreadonly phantom: unique symbol`;"],
    ["a non-readonly member", "type T = { phantom: unique symbol };"],
    ["a let declaration", "declare let phantom: unique symbol;"],
  ])("finds no declaration in %s", (_label, text) => {
    expect(keys(text)).toEqual([]);
  });

  it("identifies a declaration by its form, owner path and name", () => {
    const text = "declare const a: unique symbol;\nexport declare const z: unique symbol;\ninterface I { readonly m: unique symbol; inner: { readonly m: unique symbol } }\ntype A = { readonly m: unique symbol };";
    expect(keys(text)).toEqual(["const |  | a", "exported-const |  | z", "member | interface I | m", "member | interface I > member inner | m", "member | type A | m"]);
  });

  it("gives the same brand on two owners two different identities", () => {
    expect(keys("type A = { readonly brand: unique symbol }; type B = string;")).toEqual(["member | type A | brand"]);
    expect(keys("type A = string; type B = { readonly brand: unique symbol };")).toEqual(["member | type B | brand"]);
  });

  it("marks two declarations with one identity ambiguous, so neither is unified", () => {
    const text = "type A = { readonly b: unique symbol } | { readonly b: unique symbol };";
    expect(brandDeclarationsOf(text).map((declaration) => declaration.ambiguous)).toEqual([true, true]);
    expect(unifyBrandText(text, new Map([["member | type A | b", "brand0"]]), "/scratch/shared-brands.ts")).toBe(text);
  });

  it("rewrites only the declarations it was given a symbol for, leaving comments, strings and the line count alone", () => {
    const text = "// readonly m: unique symbol\ndeclare const a:\n  unique symbol;\nconst s = 'readonly m: unique symbol';\ntype T = { readonly m: unique symbol };\ntype U = { readonly m: unique symbol };\n";
    const unified = unifyBrandText(text, new Map([["const |  | a", "brand0"], ["member | type U | m", "brand1"]]), "/scratch/shared-brands.ts");
    expect(unified.split("\n")).toHaveLength(text.split("\n").length);
    expect(unified).toContain("// readonly m: unique symbol\nimport { brand0 as a } from \"/scratch/shared-brands.ts\";");
    expect(unified).toContain("const s = 'readonly m: unique symbol';\ntype T = { readonly m: unique symbol };");
    expect(unified).toContain('type U = { readonly m: typeof import("/scratch/shared-brands.ts").brand1 };');
  });
});

describe("the reverse probe fails a narrowed type and passes a widened one", () => {
  let fixture;
  beforeEach(() => { fixture = shapeFixture(); });
  afterEach(() => { fixture.remove(); });

  it.each([
    ["a newly required member", "count: number; added: string"],
    ["a narrowed union", "count: 1 | 2"],
  ])("fails %s in reverse only", (_label, members) => {
    const result = fixture.compare(PLAIN.replace("count: number", members), PLAIN);
    expect(coreDirections(result)).toEqual(["candidate-accepts-baseline:Wiki"]);
    expect(result.passed).toBe(false);
  });

  it("fails a brand added to a plain alias in reverse", () => {
    const result = fixture.compare(PLAIN, PLAIN.replace(BRAND, "export type EntityId = string;"));
    expect(coreDirections(result)).toContain("candidate-accepts-baseline:EntityId");
    expect(result.passed).toBe(false);
  });

  it("fails a removed optional member, which both assignment directions accept, on its keys", () => {
    const result = fixture.compare(PLAIN, PLAIN.replace("count: number", "count: number; note?: string"));
    expect(coreDirections(result)).toEqual(["baseline-keys-retained:Wiki"]);
    expect(result.passed).toBe(false);
  });

  it("passes an optional added member in both directions", () => {
    const result = fixture.compare(PLAIN.replace("count: number", "count: number; added?: string"), PLAIN);
    expect(result.findings).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

describe("a named library-owned output type may add exactly its listed members", () => {
  let fixture;
  beforeEach(() => { fixture = shapeFixture(); });
  afterEach(() => { fixture.remove(); });
  const both = [policyFor("core"), policyFor("root")];
  const added = PLAIN.replace("count: number", "count: number; added: string");

  it("passes a listed required addition through the baseline-member projection, and reports both applied policies", () => {
    const result = fixture.compare(added, PLAIN, both);
    expect(result.findings).toEqual([]);
    expect(result.outputPolicies).toEqual(["core:Wiki", "root:Wiki"]);
  });

  it("fails an addition that is not listed", () => {
    const result = fixture.compare(added.replace("added: string", "added: string; other: string"), PLAIN, both);
    expect(coreDirections(result)).toEqual(["added-members-within-policy:Wiki"]);
  });

  it("still fails a changed baseline member, in both directions", () => {
    const result = fixture.compare(PLAIN.replace("count: number", "count: string; added: string"), PLAIN, both);
    expect(coreDirections(result)).toEqual(expect.arrayContaining(["baseline-accepts-candidate:Wiki", "candidate-accepts-baseline-members:Wiki"]));
    expect(result.passed).toBe(false);
  });

  it("still fails a removed optional baseline member on its keys", () => {
    const result = fixture.compare(added, PLAIN.replace("count: number", "count: number; note?: string"), both);
    expect(coreDirections(result)).toEqual(["baseline-keys-retained:Wiki"]);
    expect(result.outputPolicies).toEqual(["core:Wiki", "root:Wiki"]);
  });

  it("exempts only its own facade, never the same name on another", () => {
    const result = fixture.compare(added, PLAIN, [policyFor("core")]);
    expect(coreDirections(result)).toEqual([]);
    expect(coreDirections(result, "root")).toEqual(["candidate-accepts-baseline:Wiki"]);
    expect(result.outputPolicies).toEqual(["core:Wiki"]);
  });
});

describe("an output policy is applied only when it is proven against the declarations", () => {
  let fixture;
  beforeEach(() => { fixture = shapeFixture(); });
  afterEach(() => { fixture.remove(); });
  const added = PLAIN.replace("count: number", "count: number; added: string");
  /** The rejections of one comparison, with the reverse finding the unapplied policy leaves. */
  const rejected = (candidate, policies) => {
    const result = fixture.compare(candidate, PLAIN, policies);
    expect(result.passed).toBe(false);
    return result;
  };

  it.each([
    ["a duplicate", [policyFor("core"), policyFor("core")], /another policy names the same facade and type/u],
    ["an unknown name", [policyFor("core", { name: "Missing" })], /baseline facade does not export this name/u],
    ["an unknown facade", [policyFor("cli")], /not one the shape check compares/u],
    ["a wrong declaration module", [policyFor("core", { declaration: { module: "src/other.ts", name: "Wiki" } })], /declared as Wiki in src\/types\.ts/u],
    ["an allowance naming a baseline member", [policyFor("core", { allowedAdditions: ["count"] })], /names baseline member/u],
    ["an empty allowance", [policyFor("core", { allowedAdditions: [] })], /non-empty list/u],
  ])("rejects %s and does not apply it", (_label, policies, reason) => {
    const result = rejected(added, policies);
    expect(result.rejectedPolicies.map((entry) => entry.reason).join(" | ")).toMatch(reason);
    expect(result.outputPolicies).toEqual([]);
    expect(coreDirections(result)).toContain("candidate-accepts-baseline:Wiki");
  });

  it("rejects a policy whose type has more than one declaration", () => {
    const result = rejected(`${added}\nexport interface Wiki { extra?: string }`, [policyFor("core")]);
    expect(result.rejectedPolicies).toEqual([{ policy: "core:Wiki", reason: "the candidate type has 2 declarations; exactly one is required" }]);
    expect(result.outputPolicies).toEqual([]);
  });
});
