/**
 * @file test/product-boundary-genericity.test.ts
 * @description The product-boundary structural control (ratified 2026-08-16):
 * core is the generic platform, and product instances live in independently
 * packageable `packages/<name>/` directories — NEVER under `src/`. Two
 * mechanical assertions over every `.ts` file in `src/`, comment lines
 * stripped:
 *
 *  1. IMPORT BAN — no core module imports from `packages/`. Configuration
 *     depends on the platform; the platform never depends on a product.
 *  2. INSTANCE BAN — no core module DEFINES a product instance: a
 *     `productId:`/`profileId:`/`templateId:` string-literal assignment naming
 *     anything but the platform default is a product being born in core.
 *
 * The allowlist covers the platform floor and the two already-shipped public
 * template identities. Those declarative compatibility templates remain usable;
 * new product identities and imports from product packages remain forbidden.
 * Tests and packages are
 * out of scope by design: tests may import packages freely, and packages ARE
 * product instances.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { SRC_DIR, srcTsFiles } from "./fixtures/src-tree.js";

/** Files allowed to carry non-default instance-id literals, and why. */
const INSTANCE_ALLOWLIST = new Set([
  "profile/default.ts", // the platform's implicit default profile
  "profile/templates/builtin/default.ts", // the default template summary
]);

/** Preserve public template releases without allowing arbitrary new identities. */
const PUBLIC_TEMPLATE_IDENTITIES = new Map([
  ["profile/templates/builtin/autosci.ts", "autosci"],
  ["profile/templates/builtin/newsroom.ts", "newsroom"],
]);

/** The repo-root packages/ directory product instances live in. */
const PACKAGES_DIR = path.resolve(SRC_DIR, "../packages");

/** External coordinators and product implementations must depend on the compiler, not vice versa. */
function isExternalProductRuntime(specifier: string): boolean {
  return /^(?:@temporalio\/|@dbos-inc\/|(?:llmflow(?:-internal)?|llmwiki-(?:autosci|newsroom))(?:\/|$))/.test(specifier);
}

/**
 * THE AUTHORITY IS TYPESCRIPT'S OWN PREPROCESSOR, not a rule this file invents.
 *
 * "Which modules does this file import" is exactly the question `preProcessFile`
 * answers, and it answers it by LEXING — so a specifier quoted in a docblock, a
 * help string, a template literal, or a regex is not an import, and an import
 * that happens to sit beside any of those still is. Two hand-rolled attempts
 * failed here before this one: a line-scoped `from`-only regex missed
 * side-effect, multiline and dynamic imports entirely, and the comment/template
 * blanking that replaced it was probed into BOTH wrong answers — real imports
 * hidden after a string containing a comment opener, between regex literals, or
 * inside a template interpolation went unreported, while ordinary help text
 * quoting a dynamic-import call was reported as a violation. A boundary control
 * that can be silently talked out of firing is worth nothing, and one that cries
 * wolf on prose gets disabled. Delegating to the compiler ends the whole class
 * rather than the instances found so far. (This docblock names those forms
 * instead of quoting them: the repository's own health scanner reads quoted
 * import syntax in a comment as a real specifier — the same blindness.)
 *
 * IT IS A FULL PARSE, not the lightweight preprocessor. `ts.preProcessFile` is a
 * scanner, and a scanner still guesses at the one genuinely ambiguous token in
 * the language: `/` opens a regex or divides. A probe of `const r = /`/;` before
 * an ordinary import walked straight past it — the scanner lost its place on the
 * backtick inside the regex and never reported the import below. Parsing costs a
 * few seconds across `src/` once and removes the last guess, so the control's
 * answer is the compiler's own syntax tree rather than an approximation of it.
 *
 * The four node shapes below are every way a module reaches another module's
 * path: import and re-export declarations (their moduleSpecifier), and `import()`
 * / `require()` calls with a literal argument. A NON-literal argument is not a
 * statically resolvable path, so it appears nowhere here — this control neither
 * resolves nor claims anything about one, deliberately.
 */
function importedSpecifiers(source: string): Array<{ pos: number; specifier: string }> {
  const parsed = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true);
  const found: Array<{ pos: number; specifier: string }> = [];
  const visit = (node: ts.Node): void => {
    const literal = declarationSpecifier(node) ?? callSpecifier(node, parsed);
    if (literal !== undefined) found.push({ pos: literal.getStart(parsed), specifier: literal.text });
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

/** The module specifier of an import or re-export declaration, when literal. */
function declarationSpecifier(node: ts.Node): ts.StringLiteralLike | undefined {
  if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) return undefined;
  const specifier = node.moduleSpecifier;
  return specifier !== undefined && ts.isStringLiteralLike(specifier) ? specifier : undefined;
}

/** The literal argument of a dynamic-import or require call, when there is one. */
function callSpecifier(node: ts.Node, parsed: ts.SourceFile): ts.StringLiteralLike | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const isModuleCall = node.expression.kind === ts.SyntaxKind.ImportKeyword
    || node.expression.getText(parsed) === "require";
  const argument = node.arguments[0];
  if (!isModuleCall || argument === undefined || !ts.isStringLiteralLike(argument)) return undefined;
  return argument;
}

/** True when a specifier, resolved from this file, lands inside packages/. */
function reachesPackages(file: string, specifier: string): boolean {
  const resolved = path.resolve(SRC_DIR, path.dirname(file), specifier);
  return resolved.startsWith(PACKAGES_DIR + path.sep);
}

/** A product/profile/template id literal being assigned something non-default. */
const NON_DEFAULT_INSTANCE = /\b(?:productId|profileId|templateId)\s*:\s*["'](?!default["'])/;

/** Only profile/template declarations of the existing identity are compatible. */
function isPublicTemplateIdentity(file: string, text: string): boolean {
  const identity = PUBLIC_TEMPLATE_IDENTITIES.get(file);
  if (!identity || /\bproductId\s*:/.test(text)) return false;
  const declarations = [...text.matchAll(/\b(?:profileId|templateId)\s*:\s*["']([^"']+)["']/g)];
  return declarations.length > 0 && declarations.every((match) => match[1] === identity);
}

/** The file's code lines (comment-only lines dropped), numbered from 1. */
function codeLines(file: string): Array<{ line: number; text: string }> {
  return readFileSync(path.join(SRC_DIR, file), "utf8")
    .split("\n")
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => !/^\s*(\*|\/\/|\/\*)/.test(text));
}

describe("product boundary: core is generic, products are packages", () => {
  it("no core module imports from packages/", () => {
    const offenders: string[] = [];
    for (const file of srcTsFiles()) {
      const source = readFileSync(path.join(SRC_DIR, file), "utf8");
      for (const { pos, specifier } of importedSpecifiers(source)) {
        if (!reachesPackages(file, specifier) && !isExternalProductRuntime(specifier)) continue;
        const line = source.slice(0, pos).split("\n").length;
        offenders.push(`src/${file}:${line}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no core module defines a product instance beyond shipped public template identities", () => {
    const offenders: string[] = [];
    for (const file of srcTsFiles()) {
      if (INSTANCE_ALLOWLIST.has(file)) continue;
      for (const { line, text } of codeLines(file)) {
        if (NON_DEFAULT_INSTANCE.test(text) && !isPublicTemplateIdentity(file, text)) {
          offenders.push(`src/${file}:${line}: ${text.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not extend template compatibility to new identities or product definitions", () => {
    const file = "profile/templates/builtin/newsroom.ts";
    expect(isPublicTemplateIdentity(file, 'profileId: "newsroom",')).toBe(true);
    expect(isPublicTemplateIdentity(file, 'profileId: "other",')).toBe(false);
    expect(isPublicTemplateIdentity(file, 'productId: "newsroom",')).toBe(false);
    expect(isPublicTemplateIdentity("commands/newsroom.ts", 'profileId: "newsroom",')).toBe(false);
  });

  it("recognizes installed product and engine imports as well as deep imports", () => {
    for (const name of ["llmwiki-autosci", "llmwiki-newsroom/helpers", "llmflow", "@temporalio/worker", "@dbos-inc/dbos-sdk"]) {
      expect(isExternalProductRuntime(name)).toBe(true);
    }
    expect(isExternalProductRuntime("../profile/templates/builtin/newsroom.js")).toBe(false);
    expect(isExternalProductRuntime("./workflows/start.js")).toBe(false);
  });

  it("does not declare known product or orchestration packages as compiler dependencies", () => {
    const manifest = JSON.parse(readFileSync(path.resolve(SRC_DIR, "../package.json"), "utf8"));
    const names = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
      .flatMap((field) => Object.keys(manifest[field] ?? {}));
    expect(names.filter(isExternalProductRuntime)).toEqual([]);
  });
});
