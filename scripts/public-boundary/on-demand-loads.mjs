/**
 * @file scripts/public-boundary/on-demand-loads.mjs
 * @description What one source file loads through the project's ONE canonical
 * synchronous on-demand loader: `requireOnUse`, exported by
 * `src/utils/require-on-use.ts`.
 *
 * That loader calls `createRequire(import.meta.url)(specifier)`, so the import
 * graph sees only a `createRequire` binding inside the loader and nothing at
 * its callers. This reader gives the graph what the callers load, read from
 * each caller's TypeScript AST:
 *
 * - Authority comes only from an actual named import of `requireOnUse` from a
 *   specifier that resolves to the loader module; an alias
 *   (`import { requireOnUse as load }`) is followed. A same-named function, or
 *   an import of that name from any other module, has no loader authority.
 * - A load is a direct call of such a binding with exactly one non-empty,
 *   non-absolute string literal (type arguments are allowed, and so is the call
 *   inside `new (…)(…)`). Its specifier is returned for the graph to resolve
 *   FROM THE LOADER'S location, as Node's `createRequire(import.meta.url)` there
 *   does, never from the caller.
 * - Everything that could hide a load is REFUSED, and reported, never ignored:
 *   - an optional call, or a call with no, several, spread, empty, absolute or
 *     non-literal arguments;
 *   - any other use of the binding (passed, stored, exported, `typeof`,
 *     reassigned, parenthesised callee);
 *   - a redeclaration that shadows it;
 *   - a default or namespace import of the loader module, or a re-export from
 *     it;
 *   - a literal dynamic `import()` or `require()` of it.
 *
 * Limits:
 * - This is a syntactic, per-file rule for this one helper. It does no
 *   control-flow evaluation and builds no TypeScript program.
 * - It refuses conservatively instead of reasoning about scopes: a shadowing
 *   declaration anywhere in the file refuses the file, even in an unrelated
 *   scope.
 * - It does not run or prove what the loader does at run time. The loader's
 *   own `createRequire` is admitted separately, by an exception pinned to the
 *   loader's exact source hash, and a changed loader body loses that exception.
 * - The loader module itself is not read as a caller.
 */

import { createRequire } from "node:module";

const ts = createRequire(import.meta.url)("typescript");

/** The canonical on-demand loader: its repository-relative module and its exported name. */
export const ON_DEMAND_LOADER = Object.freeze({ module: "src/utils/require-on-use.ts", name: "requireOnUse" });

/** The construct name the loads and refusals of this loader carry. */
const CONSTRUCT = "require-on-use";

/** `{ line, expression }` of a node, in the same shape as the graph's references. */
function locator(sourceFile) {
  return (node) => ({ line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, expression: node.getText(sourceFile).replace(/\s+/gu, " ") });
}

/** Whether an import or export statement names, by a string specifier, a module that resolves to the loader. */
function namesLoader(statement, resolvesToLoader) {
  const specifier = statement.moduleSpecifier;
  return specifier !== undefined && ts.isStringLiteral(specifier) && resolvesToLoader(specifier.text);
}

/** The local names one import of the loader module binds to `requireOnUse`; a default or namespace import is refused. */
function importBindings(statement, at, refusals) {
  const clause = statement.importClause;
  if (clause === undefined || clause.isTypeOnly) return [];
  if (clause.name !== undefined) refusals.push({ ...at(statement), construct: CONSTRUCT, reason: "default import of the on-demand loader module" });
  const named = clause.namedBindings;
  if (named !== undefined && !ts.isNamedImports(named)) {
    refusals.push({ ...at(statement), construct: CONSTRUCT, reason: "namespace import of the on-demand loader module" });
    return [];
  }
  return (named?.elements ?? []).filter((element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === ON_DEMAND_LOADER.name)
    .map((element) => element.name.text);
}

/** The local loader bindings of one file; a runtime re-export from the loader module is refused. */
function loaderBindings(sourceFile, at, resolvesToLoader, refusals) {
  const bindings = new Set();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && namesLoader(statement, resolvesToLoader)) {
      for (const name of importBindings(statement, at, refusals)) bindings.add(name);
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && namesLoader(statement, resolvesToLoader)) {
      refusals.push({ ...at(statement), construct: CONSTRUCT, reason: "re-export from the on-demand loader module" });
    }
  }
  return bindings;
}

/** Whether a node is a literal dynamic `import()` or `require()` of the loader module (access that bypasses the named import). */
function isDynamicLoaderAccess(node, resolvesToLoader) {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return false;
  const loadsModule = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require");
  const [first] = node.arguments;
  return loadsModule && ts.isStringLiteralLike(first) && resolvesToLoader(first.text);
}

/** The node kinds whose `name` is a property or member NAME, not a reference to a binding. */
const MEMBER_NAME_KINDS = ["isPropertyAssignment", "isPropertyDeclaration", "isMethodDeclaration", "isPropertySignature", "isMethodSignature",
  "isGetAccessorDeclaration", "isSetAccessorDeclaration", "isEnumMember"];

/** Whether an identifier only names a property or member (`a.requireOnUse`, `{ requireOnUse: x }`, a class member), not the binding. */
function isMemberName(identifier) {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return true;
  if (ts.isQualifiedName(parent) && parent.right === identifier) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === identifier) return true;
  return MEMBER_NAME_KINDS.some((kind) => ts[kind](parent) && parent.name === identifier);
}

/** The node kinds whose `name` declares a new binding (which would shadow the loader binding). */
const DECLARATION_KINDS = ["isVariableDeclaration", "isParameter", "isFunctionDeclaration", "isFunctionExpression", "isClassDeclaration", "isClassExpression",
  "isBindingElement", "isImportEqualsDeclaration", "isTypeAliasDeclaration", "isInterfaceDeclaration", "isEnumDeclaration", "isTypeParameterDeclaration"];

/** Whether an identifier is the name a declaration introduces. */
function isDeclarationName(identifier) {
  return DECLARATION_KINDS.some((kind) => ts[kind](identifier.parent) && identifier.parent.name === identifier);
}

/** Whether an identifier is an import specifier, or an export specifier of a re-export from some module (binding sites, not uses). */
function isBindingSite(identifier) {
  const parent = identifier.parent;
  if (ts.isImportSpecifier(parent)) return true;
  return ts.isExportSpecifier(parent) && parent.parent.parent.moduleSpecifier !== undefined;
}

/** The specifier one direct loader call loads, or the reason the call is refused. */
function callLoad(call) {
  if (call.questionDotToken !== undefined) return { reason: "optional call of the on-demand loader" };
  if (call.arguments.length !== 1) return { reason: "the on-demand loader must be called with exactly one argument" };
  const [argument] = call.arguments;
  if (ts.isSpreadElement(argument)) return { reason: "spread argument to the on-demand loader" };
  if (!ts.isStringLiteralLike(argument)) return { reason: "non-literal on-demand load specifier" };
  if (argument.text === "" || argument.text.startsWith("/")) return { reason: "empty or absolute on-demand load specifier" };
  return { specifier: argument.text };
}

/** Classify one occurrence of a loader binding as a load, a refusal, or a binding site that is neither. */
function classifyUse(identifier, at, loads, refusals) {
  const parent = identifier.parent;
  if (isBindingSite(identifier) || isMemberName(identifier)) return;
  if (isDeclarationName(identifier)) {
    refusals.push({ ...at(parent), construct: CONSTRUCT, reason: "the on-demand loader binding is shadowed or redeclared" });
    return;
  }
  if (!ts.isCallExpression(parent) || parent.expression !== identifier) {
    refusals.push({ ...at(parent), construct: CONSTRUCT, reason: "the on-demand loader is used other than as a direct call" });
    return;
  }
  const load = callLoad(parent);
  if (load.reason !== undefined) refusals.push({ ...at(parent), construct: CONSTRUCT, reason: load.reason });
  else loads.push({ ...at(parent), construct: CONSTRUCT, specifier: load.specifier, kind: "runtime" });
}

/**
 * The on-demand loads one parsed module makes, and the refused uses of the loader.
 *
 * @param sourceFile - The module's TypeScript AST.
 * @param module - Its repository-relative path.
 * @param resolvesToLoader - Whether a specifier written in `module` resolves to {@link ON_DEMAND_LOADER}.module.
 * @returns `loads`: `{ construct, specifier, kind, line, expression }` per supported call, whose specifier
 *   the caller must resolve from the loader's location; `refusals`: `{ construct, line, expression, reason }`.
 */
export function onDemandLoadsOf(sourceFile, module, resolvesToLoader) {
  const loads = [];
  const refusals = [];
  if (module === ON_DEMAND_LOADER.module) return { loads, refusals };
  const at = locator(sourceFile);
  const bindings = loaderBindings(sourceFile, at, resolvesToLoader, refusals);
  const visit = (node) => {
    if (isDynamicLoaderAccess(node, resolvesToLoader)) refusals.push({ ...at(node), construct: CONSTRUCT, reason: "dynamic import() or require() of the on-demand loader module" });
    if (ts.isIdentifier(node) && bindings.has(node.text)) classifyUse(node, at, loads, refusals);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { loads, refusals };
}
