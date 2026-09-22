/**
 * @file test/preparations/lifecycle-model/source-text.test.ts
 * @description The source reader's own controls.
 *
 * Six structural controls depend on this module, so a defect here is a defect in
 * all six at once — and this helper has been defeated three times, each time by a
 * literal form the previous implementation did not know about:
 *
 * 1. a regex stripper counted an identifier inside a COMMENT as a use;
 * 2. a string-aware rewrite still treated a comment marker inside a REGEX
 *    LITERAL as a comment, erasing the rest of the file;
 * 3. driving the compiler's SCANNER did not fix it either, because the scanner
 *    only yields a regex literal when the consumer calls `reScanSlashToken()`
 *    from grammar context — which a bare `scan()` loop does not have.
 *
 * Each round was found by an adversarial reviewer rather than by these tests,
 * because these tests did not exist. They do now, and they carry the exact
 * inputs that defeated each version.
 *
 * Both directions matter equally. A false GREEN hides a real reach; a false RED
 * makes an honest module or an accurate citation look like a violation, and a
 * control that cries wolf gets deleted.
 *
 * ONE RULE FOR ADDING TO THIS FILE: the fixture must contain the shape it
 * defends against. Three of the five defeats slipped past fixtures that were too
 * simple to fail — one comment cannot expose an offset-drift bug, a synthetic
 * file cannot produce the duplicate ranges a real one does, and a construct with
 * child nodes cannot expose a walker that skips tokens. A test named for a
 * general property whose fixture holds a single easy instance is usually testing
 * nothing.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { declaresSymbol, referencesSymbol, withoutComments } from "./source-text.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/** A regex character class containing the block-comment opener. Valid JS. */
const REGEX_WITH_COMMENT_OPENER = "const SEP = /[/*]/u;";

describe("withoutComments", () => {
  it("keeps code that follows a regex literal containing a comment opener", () => {
    // The defeat that survived two rewrites: everything after this line was
    // erased, hiding a live import from four pattern-matching controls.
    const source = `${REGEX_WITH_COMMENT_OPENER}\nimport { readFile } from "node:fs/promises";\n`;
    expect(withoutComments(source)).toContain("node:fs/promises");
  });

  it("still removes an ordinary block comment", () => {
    // The control. Without it, "keeps code" is satisfiable by stripping nothing.
    expect(withoutComments("/** docs */\nconst x = 1;\n")).not.toContain("docs");
  });

  it("does not treat a comment marker inside a string as a comment", () => {
    expect(withoutComments('const glob = "/*";\nconst after = 1;\n')).toContain("after");
  });

  it("survives a source with SEVERAL comments", async () => {
    // MULTI-comment ON PURPOSE. Every earlier fixture here had at most one, and
    // that is exactly why the defect this pins shipped: deleting comment text
    // shortens the string while later ranges still index the ORIGINAL source, so
    // the second range onward slices in the wrong place. Measured on the version
    // that shipped: `import { readFile } from` became `import { reafrom`, and two
    // comments survived. One comment cannot expose it.
    const source = [
      "/** a */", "const x = 1;", "/** b */",
      'import { readFile } from "node:fs/promises";', "/** c */", "const y = 2;", "",
    ].join("\n");
    const stripped = withoutComments(source);
    expect(stripped).toContain('import { readFile } from "node:fs/promises";');
    expect(stripped).not.toMatch(/\*\* [abc]/u);
  });

  it("leaves a real production module's imports byte-for-byte intact", async () => {
    // A synthetic fixture can be built to pass. This exercises the duplicate and
    // out-of-order ranges a real file actually produces — one comment is the
    // LEADING comment of one node and the TRAILING comment of another, so the
    // same range is collected several times.
    const file = path.join(REPO_ROOT, "src/preparations/reset.ts");
    const source = await readFile(file, "utf8");
    const importLines = (text: string) => text.split("\n").filter((line) => line.startsWith("import ")).length;

    const stripped = withoutComments(source);
    expect(importLines(stripped)).toBe(importLines(source));
    expect(stripped).toHaveLength(source.length);
    expect(stripped).not.toContain("/*");
  });

  it("reaches comments inside constructs that have no child nodes", () => {
    // `forEachChild` skips tokens, so a comment in an empty block, an empty
    // parameter list or an empty array literal was never visited and survived.
    // `function noop() { /* ... */ }` is common, and a symbol mentioned inside
    // one read as code — the cry-wolf direction through a fourth door.
    for (const source of [
      "function noop() { /* runTwoPhaseQuarantine */ }",
      "function f(/* runTwoPhaseQuarantine */) {}",
      "const a = [/* runTwoPhaseQuarantine */];",
      "const o = {/* runTwoPhaseQuarantine */};",
      "class C {/* runTwoPhaseQuarantine */}",
      "const g = () => {/* runTwoPhaseQuarantine */};",
    ]) expect(withoutComments(source)).not.toContain("runTwoPhaseQuarantine");
  });

  it("preserves line positions so line-oriented checks stay aligned", () => {
    const source = "const a = 1;\n/* two\n   lines */\nconst b = 2;\n";
    expect(withoutComments(source).split("\n")).toHaveLength(source.split("\n").length);
  });
});

describe("referencesSymbol", () => {
  it("finds a symbol reached through a dynamic import", () => {
    const source = 'const f = (await import("./x.js")).runTwoPhaseQuarantine;\n';
    expect(referencesSymbol(source, "runTwoPhaseQuarantine")).toBe(true);
  });

  it("finds a symbol hidden after a regex literal containing a comment opener", () => {
    const source = `${REGEX_WITH_COMMENT_OPENER}\nexport const f = runTwoPhaseQuarantine;\n`;
    expect(referencesSymbol(source, "runTwoPhaseQuarantine")).toBe(true);
  });

  it("does not count a mention in a comment", () => {
    // The cry-wolf direction: a docblock saying a module must NOT call something
    // was read as calling it, which turned two controls red for documenting them.
    const source = "// never call runTwoPhaseQuarantine here\nconst x = 1;\n";
    expect(referencesSymbol(source, "runTwoPhaseQuarantine")).toBe(false);
  });

  it("does not count a mention inside a string literal", () => {
    expect(referencesSymbol('const s = "runTwoPhaseQuarantine";\n', "runTwoPhaseQuarantine")).toBe(false);
  });
});

describe("declaresSymbol", () => {
  it("resolves a top-level declaration that follows a regex literal", () => {
    // The false-RED direction of the same defect: one plausible regex constant
    // above an honest seam made a correct protocol-map citation unresolvable.
    const source = `${REGEX_WITH_COMMENT_OPENER}\nexport function movePhase() { return 1; }\n`;
    expect(declaresSymbol(source, "movePhase")).toBe(true);
  });

  it("refuses a declaration that is local to a function", () => {
    // A citation claims a named thing lives in a named file. A function-local
    // const is not that, and review used one to satisfy the previous version.
    const source = "function outer() {\n  const namespace = 1;\n  return namespace;\n}\n";
    expect(declaresSymbol(source, "namespace")).toBe(false);
  });

  it("refuses a symbol that only appears in prose", () => {
    expect(declaresSymbol("/** movePhase moves bytes. */\nconst other = 1;\n", "movePhase")).toBe(false);
  });
});
