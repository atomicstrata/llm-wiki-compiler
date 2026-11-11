/**
 * @file test/preparations/lifecycle-model/source-text.ts
 * @description Reading production source as CODE rather than as text, shared by
 * every structural control that inspects it.
 *
 * Several controls resolve claims by reading source, and they were defeated
 * repeatedly by the same thing: text that LOOKS like code but is not, and code
 * that a naive reader mistakes for text.
 *
 * The history is the argument for the current shape. A regex stripper counted an
 * identifier inside a COMMENT as a use. Making it string-aware fixed that and
 * left REGEX LITERALS unhandled — `/[/*]/u` is valid JavaScript, and its `/*`
 * opened a comment that swallowed the rest of the file, hiding a live call to
 * the custody protocol from six controls at once. Two hand-rolled rewrites, two
 * missed literal forms.
 *
 * So this stops hand-rolling. TypeScript is already a dependency and its scanner
 * and parser are the same ones the compiler uses, which is exactly the authority
 * these controls need: they only have to agree with the compiler about where
 * identifiers are.
 */

import path from "node:path";
import ts from "typescript";

/**
 * Everything these controls ask of one source text, answered from ONE parse.
 *
 * The controls re-ask about the same files from many tests and helpers, and
 * each question used to re-parse: one structural suite spent nearly all of its
 * CPU in the compiler's parser. The answers are kept rather than the syntax
 * tree, because a tree is roughly forty times its source and these controls
 * read all of `src/` twice over (raw and comment-stripped).
 *
 * Keyed by the text itself plus the part of the file name the parser reads, so
 * no file change can hide behind a memo: different bytes are a different key
 * and are parsed afresh.
 */
interface SourceFacts {
  readonly stripped: string;
  readonly identifiers: ReadonlySet<string>;
  readonly declared: ReadonlySet<string>;
  readonly staticSpecifiers: readonly string[];
  readonly dynamicSpecifiers: readonly string[];
}

const factsBySource = new Map<string, SourceFacts>();

/**
 * The name the parser actually sees: only a file name's suffix steers a parse
 * (script kind from the extension, ambient context from `.d.ts`), so every
 * name sharing that suffix parses a given text identically.
 */
function parseName(fileName: string): string {
  const base = path.basename(fileName);
  const dot = base.indexOf(".");
  return dot < 0 ? "probe" : `probe${base.slice(dot)}`;
}

/** The memoized facts of one text, parsing it the first time it is asked about. */
function factsOf(fileName: string, source: string): SourceFacts {
  const name = parseName(fileName);
  const key = `${name}\0${source}`;
  let facts = factsBySource.get(key);
  if (facts === undefined) {
    facts = computeFacts(ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true), source);
    factsBySource.set(key, facts);
  }
  return facts;
}

/** Every fact, from one tree that is dropped afterwards. */
function computeFacts(parsed: ts.SourceFile, source: string): SourceFacts {
  const { identifiers, dynamicSpecifiers } = walkExpressions(parsed);
  return {
    stripped: blankComments(parsed, source),
    identifiers,
    declared: new Set(parsed.statements.flatMap(declaredNames)),
    staticSpecifiers: staticSpecifiersOf(parsed),
    dynamicSpecifiers,
  };
}

/**
 * Source with comments blanked, for the controls that match a PATTERN rather
 * than an identifier — import specifiers, call shapes, `.confirmation` receivers.
 *
 * Comment ranges come from the PARSER, not the scanner. That distinction is the
 * whole fix and I got it wrong once: `ts.createScanner` emits `SlashToken` for
 * `/` and only yields a regex literal when the consumer calls
 * `reScanSlashToken()`, which the real parser does from grammar context. A bare
 * `scan()` loop has no context, so `/[` scans as ordinary tokens and the `/*`
 * that follows scans as a block comment — erasing the rest of the file. Swapping
 * a hand-rolled lexer for the compiler's SCANNER did not buy the context; only
 * the parser has it.
 *
 * Comments are overwritten with SPACES rather than deleted, which is what makes
 * the loop correct rather than merely well-intentioned. Deleting shortens the
 * string as it goes while every later range still indexes into the ORIGINAL
 * source, so each subsequent slice lands in the wrong place — measured, that ate
 * eight characters out of the middle of a live import and left two comments
 * standing. The same collection also yields DUPLICATE ranges, because one
 * comment is the leading comment of one node and the trailing comment of
 * another. Preserving length makes both harmless: offsets never move, so
 * repeated or out-of-order ranges are idempotent, and columns survive as well as
 * lines.
 */
export function withoutComments(source: string): string {
  return factsOf("probe.ts", source).stripped;
}

/** {@link withoutComments} over an already-parsed text. */
function blankComments(parsed: ts.SourceFile, source: string): string {
  // Every comment the parser reports starts with `//` or `/*`, so a text with
  // neither has nothing to blank — the comment-stripped texts the controls
  // re-parse are mostly this case, and the token walk below is the costly part.
  if (!source.includes("//") && !source.includes("/*")) return source;
  const ranges: ts.CommentRange[] = [];
  const collect = (node: ts.Node): void => {
    for (const range of ts.getLeadingCommentRanges(source, node.pos) ?? []) ranges.push(range);
    for (const range of ts.getTrailingCommentRanges(source, node.end) ?? []) ranges.push(range);
    // getChildren(), not forEachChild(): forEachChild skips TOKENS, so a comment
    // inside a construct with no child NODES — an empty block, an empty
    // parameter list, an empty array literal — is never reached and survives
    // stripping. `function noop() { /* ... */ }` is common enough that this
    // returned the cry-wolf failure through a fourth door.
    for (const child of node.getChildren()) collect(child);
  };
  collect(parsed);
  const blanked = source.split("");
  for (const range of ranges) {
    for (let index = range.pos; index < range.end; index += 1) {
      if (blanked[index] !== "\n") blanked[index] = " ";
    }
  }
  return blanked.join("");
}

/**
 * True when `source` DECLARES `symbol` at the TOP LEVEL.
 *
 * Top level specifically. A citation claims a named thing lives in a named file;
 * review satisfied an earlier version with a function-LOCAL `const` inside an
 * unrelated function, which is not the seam a row means.
 */
export function declaresSymbol(source: string, symbol: string): boolean {
  return factsOf("probe.ts", source).declared.has(symbol);
}

/** The top-level names one statement introduces. */
function declaredNames(statement: ts.Statement): string[] {
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
    return statement.name === undefined ? [] : [statement.name.text];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .filter((declaration) => ts.isIdentifier(declaration.name))
      .map((declaration) => (declaration.name as ts.Identifier).text);
  }
  return [];
}

/**
 * True when `source` REFERENCES `symbol` as an identifier anywhere in code.
 *
 * Deliberately not an import-shaped match: matching braced imports only let a
 * namespace import and a dynamic import reach the custody protocol with the
 * control green. Asking the AST whether the identifier appears at all closes
 * every import form, every literal form, and every syntax nobody has thought of
 * yet — a mention in a comment or a string is not an identifier node, so it
 * cannot satisfy this and cannot falsely trip it either.
 */
export function referencesSymbol(source: string, symbol: string): boolean {
  return factsOf("probe.ts", source).identifiers.has(symbol);
}

/**
 * Every identifier in code, and every dynamic-import specifier, in one walk.
 *
 * `forEachChild` here is CORRECT and should stay, unlike in the comment-range
 * walk above. It skips punctuation and keyword tokens, but an identifier is
 * always reachable as a named semantic child, so none is missed. The token gap
 * only ever mattered for comment RANGES, which attach to positions rather than
 * nodes. Noted so a later sweep for "forEachChild considered harmful" does not
 * churn it.
 */
function walkExpressions(parsed: ts.SourceFile): { identifiers: Set<string>; dynamicSpecifiers: string[] } {
  const identifiers = new Set<string>();
  const dynamicSpecifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    const specifier = dynamicImportSpecifierOf(node);
    if (specifier !== undefined) dynamicSpecifiers.push(specifier);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return { identifiers, dynamicSpecifiers };
}

/**
 * Every module specifier a file imports, from the PARSER.
 *
 * Two regexes stood here and each had a blind spot that a control then certified:
 * one matched `from "..."` only, so a side-effect `import "./x.js"` was invisible
 * and an unclassified module reached that way passed every structural control;
 * the other matched `node:fs` only, so `from "fs/promises"` read as "no raw
 * filesystem access" and a demonstrably false classification went green.
 *
 * The parser has no spelling opinions. `import`, `import type`, side-effect
 * imports, and `export ... from` all surface here, which is what the callers
 * actually mean by "what does this module reach".
 *
 * DYNAMIC IMPORTS COUNT, and their omission was a third blind spot of exactly
 * the same shape. A top-level-statement walk cannot see a dynamic `await import` expression,
 * which is an expression and can sit anywhere — so a module reaching the
 * preparation substrate, or `node:fs/promises`, through one was invisible to
 * every consumer of this function while they reported green. `referencesSymbol`
 * in this same file was made AST-identifier-based for precisely this vector;
 * this is the same lesson applied one function over. The whole tree is walked
 * for dynamic-import call expressions with a string-literal argument.
 */
export function importedSpecifiers(fileName: string, source: string): string[] {
  const facts = factsOf(fileName, source);
  return [...facts.staticSpecifiers, ...facts.dynamicSpecifiers];
}

/** The specifiers of top-level `import` and `export … from` statements, in order. */
function staticSpecifiersOf(parsed: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  for (const statement of parsed.statements) {
    const clause = ts.isImportDeclaration(statement)
      ? statement.moduleSpecifier
      : ts.isExportDeclaration(statement) ? statement.moduleSpecifier : undefined;
    if (clause !== undefined && ts.isStringLiteral(clause)) specifiers.push(clause.text);
  }
  return specifiers;
}

/**
 * Every dynamic-import specifier a file reaches, and nothing else.
 *
 * Exported separately because a dynamic import is ALWAYS a value reach — there
 * is no `import type(…)` — while the static forms {@link importedSpecifiers}
 * also returns are a mix of value and type. A caller that needs "what could
 * this module CALL" has to be able to ask for the dynamic ones alone.
 */
export function dynamicImportSpecifiers(fileName: string, source: string): string[] {
  return [...factsOf(fileName, source).dynamicSpecifiers];
}

/** The specifier of one dynamic-import call, when `node` is one with a literal argument. */
function dynamicImportSpecifierOf(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined;
  const [argument] = node.arguments;
  // A non-literal argument is a specifier nothing static can resolve; it is
  // out of scope rather than silently treated as absent.
  return argument !== undefined && ts.isStringLiteral(argument) ? argument.text : undefined;
}

/** Whether a module statically imports Node's filesystem API, in ANY spelling. */
export function importsNodeFilesystem(fileName: string, source: string): boolean {
  return importedSpecifiers(fileName, source).some((specifier) =>
    ["fs", "fs/promises", "node:fs", "node:fs/promises"].includes(specifier));
}
