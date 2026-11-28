/**
 * @file scripts/public-boundary/brands.mjs
 * @description Comparison-only unification of `unique symbol` brands for the
 * SHAPE check. It changes nothing in the product: it rewrites the text the
 * comparison program reads, never a file on disk.
 *
 * The shape check loads two copies of the source (the public baseline and
 * this tree). Each copy declares its own brand symbol, so a branded type in
 * one copy is never assignable to the other's, and TypeScript stops at that
 * difference without reporting any other in the same type. Discarding such a
 * diagnostic would hide a real break beside the brand.
 *
 * Instead, a brand is ONE brand in both trees only when its DECLARATION
 * corresponds: the same module (repository-relative path), the same owner
 * path (the named declarations that enclose it: a type alias, an interface,
 * a class, a namespace, an enclosing member), the same name and the same
 * form. Both declarations are then rewritten to name one shared symbol in a
 * generated module, and the ordinary structural comparison runs over
 * everything else.
 *
 * Declarations are found in the TypeScript syntax tree, never by matching
 * text: a comment, a string or a template literal that merely spells a brand
 * is not a declaration. A brand that only one tree declares, or that moved to
 * another owner, changed name or changed form, is NOT unified, so it stays a
 * real difference and the check fails on it. Two declarations of one module
 * that would share an identity are AMBIGUOUS: neither is unified.
 *
 * Two declaration forms are recognised, the two this codebase uses:
 *   `declare const name: unique symbol;`   (a module-level statement, optionally exported)
 *   `readonly name: unique symbol`         (a property signature of a type)
 * Any other form is not unified: it fails closed.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const ts = createRequire(import.meta.url)("typescript");

/** Whether a type node is exactly `unique symbol`. */
function isUniqueSymbolType(node) {
  return node !== undefined && ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.UniqueKeyword && node.type.kind === ts.SyntaxKind.SymbolKeyword;
}

/** Whether a node carries the given modifier keyword. */
function hasModifier(node, kind) {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

/** Whether a node is a member-like declaration: a property signature or declaration, or a parameter. */
function isMemberLike(node) {
  return ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node);
}

/** The class segment: a class keeps its place in the path even when anonymous. */
function classSegment(node) {
  return `class ${node.name?.text ?? "(anonymous)"}`;
}

/**
 * The owner-path segment of each declaration kind, tried in this order (the
 * first match wins); each returns null for a node it does not name. A function
 * or member without a name contributes nothing.
 */
const OWNER_SEGMENTS = [
  (node) => (ts.isTypeAliasDeclaration(node) ? `type ${node.name.text}` : null),
  (node) => (ts.isInterfaceDeclaration(node) ? `interface ${node.name.text}` : null),
  (node) => (ts.isClassLike(node) ? classSegment(node) : null),
  (node, source) => (ts.isModuleDeclaration(node) ? `namespace ${node.name.getText(source)}` : null),
  (node, source) => (ts.isFunctionLike(node) && node.name !== undefined ? `function ${node.name.getText(source)}` : null),
  (node, source) => (ts.isVariableDeclaration(node) ? `variable ${node.name.getText(source)}` : null),
  (node, source) => (isMemberLike(node) && node.name !== undefined ? `member ${node.name.getText(source)}` : null),
];

/** The name an enclosing declaration contributes to an owner path, or null when it contributes none. */
function ownerSegment(node, source) {
  for (const segmentOf of OWNER_SEGMENTS) {
    const segment = segmentOf(node, source);
    if (segment !== null) return segment;
  }
  return null;
}

/** The named declarations enclosing `node`, outermost first. */
function ownerPathOf(node, source) {
  const segments = [];
  for (let current = node.parent; current !== undefined && !ts.isSourceFile(current); current = current.parent) {
    const segment = ownerSegment(current, source);
    if (segment !== null) segments.unshift(segment);
  }
  return segments.join(" > ");
}

/** A module-level `declare const name: unique symbol;` statement as a brand declaration, or null. */
function constantBrandOf(statement, source) {
  if (!ts.isVariableStatement(statement) || !hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) return null;
  const { declarations, flags } = statement.declarationList;
  if ((flags & ts.NodeFlags.Const) === 0 || declarations.length !== 1) return null;
  const [declaration] = declarations;
  if (!ts.isIdentifier(declaration.name) || !isUniqueSymbolType(declaration.type)) return null;
  const form = hasModifier(statement, ts.SyntaxKind.ExportKeyword) ? "exported-const" : "const";
  return { form, name: declaration.name.text, owner: "", start: statement.getStart(source), end: statement.end };
}

/** A `readonly name: unique symbol` property signature as a brand declaration (its TYPE is the range rewritten), or null. */
function memberBrandOf(node, source) {
  if (!ts.isPropertySignature(node) || !hasModifier(node, ts.SyntaxKind.ReadonlyKeyword) || !isUniqueSymbolType(node.type)) return null;
  if (!ts.isIdentifier(node.name)) return null;
  return { form: "member", name: node.name.text, owner: ownerPathOf(node, source), start: node.type.getStart(source), end: node.type.end };
}

/** The identity of one declaration within its module: form, owner path and name. */
function keyOf(declaration) {
  return `${declaration.form} | ${declaration.owner} | ${declaration.name}`;
}

/**
 * Every brand declaration in one source text, from its syntax tree.
 *
 * @returns Each declaration with its `key` (form, owner path, name), the text
 *   range a rewrite replaces, and `ambiguous: true` when another declaration
 *   of the same module has the same key.
 */
export function brandDeclarationsOf(text, fileName = "module.ts") {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const found = source.statements.flatMap((statement) => constantBrandOf(statement, source) ?? []);
  const visit = (node) => {
    const member = memberBrandOf(node, source);
    if (member !== null) found.push(member);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const counts = new Map();
  for (const declaration of found) counts.set(keyOf(declaration), (counts.get(keyOf(declaration)) ?? 0) + 1);
  return found.map((declaration) => ({ ...declaration, key: keyOf(declaration), ambiguous: counts.get(keyOf(declaration)) > 1 }));
}

/** The unambiguous declaration keys of one tree's module (none when the module is absent), and its ambiguous ones. */
function keysOf(dir, file) {
  let text;
  try { text = readFileSync(path.join(dir, file), "utf8"); } catch { return { usable: new Set(), ambiguous: [] }; }
  const declarations = brandDeclarationsOf(text, file);
  return { usable: new Set(declarations.filter((entry) => !entry.ambiguous).map((entry) => entry.key)),
    ambiguous: [...new Set(declarations.filter((entry) => entry.ambiguous).map((entry) => entry.key))] };
}

/**
 * Pair the brands of the two trees.
 *
 * @param files - Repository-relative source paths to consider.
 * @returns `shared`: per module, the declaration keys both trees have, each
 *   with its shared symbol name; `unmatched`: every declaration only one tree
 *   has and every ambiguous one (reported, and left as a real difference);
 *   `moduleText`: the generated module declaring one symbol per shared brand.
 */
export function pairBrands(candidateRoot, baselineDir, files) {
  const shared = new Map();
  const unmatched = [];
  const symbols = [];
  for (const file of files) {
    const baseline = keysOf(baselineDir, file);
    const candidate = keysOf(candidateRoot, file);
    const both = new Map();
    for (const key of [...baseline.usable].filter((entry) => candidate.usable.has(entry))) {
      both.set(key, `brand${symbols.length}`);
      symbols.push(`/** ${file}: ${key} */\nexport declare const brand${symbols.length}: unique symbol;`);
    }
    if (both.size > 0) shared.set(file, both);
    unmatched.push(...[...baseline.usable].filter((key) => !candidate.usable.has(key)).map((brand) => ({ file, brand, only: "baseline" })));
    unmatched.push(...[...candidate.usable].filter((key) => !baseline.usable.has(key)).map((brand) => ({ file, brand, only: "candidate" })));
    unmatched.push(...baseline.ambiguous.map((brand) => ({ file, brand, only: "baseline", ambiguous: true })));
    unmatched.push(...candidate.ambiguous.map((brand) => ({ file, brand, only: "candidate", ambiguous: true })));
  }
  return { shared, unmatched, moduleText: `${symbols.join("\n")}\nexport {};\n` };
}

/** The replacement of one shared declaration's range; a statement keeps its line count. */
function replacementOf(declaration, symbol, original, specifier) {
  if (declaration.form === "member") return `typeof import(${specifier}).${symbol}`;
  const padding = "\n".repeat(original.split("\n").length - 1);
  return `import { ${symbol} as ${declaration.name} } from ${specifier};${declaration.form === "exported-const" ? ` export { ${declaration.name} };` : ""}${padding}`;
}

/**
 * One module's text with each shared brand declaration naming the shared
 * symbol. Only the declarations' own ranges change; the line count and every
 * other character, comments and strings included, are unchanged.
 *
 * @param keys - The module's shared declaration keys and their symbol names.
 * @param brandsModule - Absolute path of the generated module.
 */
export function unifyBrandText(text, keys, brandsModule, fileName = "module.ts") {
  const specifier = JSON.stringify(brandsModule);
  const shared = brandDeclarationsOf(text, fileName).filter((declaration) => !declaration.ambiguous && keys.has(declaration.key));
  let unified = text;
  for (const declaration of shared.sort((left, right) => right.start - left.start)) {
    const original = unified.slice(declaration.start, declaration.end);
    unified = unified.slice(0, declaration.start) + replacementOf(declaration, keys.get(declaration.key), original, specifier) + unified.slice(declaration.end);
  }
  return unified;
}
