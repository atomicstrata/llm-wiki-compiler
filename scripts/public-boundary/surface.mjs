/**
 * @file scripts/public-boundary/surface.mjs
 * @description The public SURFACE checks of the release gate, run on the
 * PUBLIC release composition: the three checked-in public facades, and the CLI
 * commands and MCP tools registered by the modules the public CLI entry
 * actually reaches.
 *
 * A public facade must equal what the manifest derives, export nothing beyond
 * the recorded public baseline plus the allocated additions, and drop no
 * baseline name. Commands and tools are read from the TypeScript AST of the
 * reachable registrars (`program.command("…")`, `registerTool("…")`), so an
 * internal registrar that the public entry does not import is not counted,
 * and one it does import cannot hide.
 *
 * The CLI entry declares its top-level commands lazily: it passes a table of
 * `[usage, description, load]` entries to `declareLazyCommands(program, TABLE)`
 * from `src/cli/lazy-commands.ts`. That table is read too, but only in the one
 * form the CLI uses: the declarer bound by a named import of that module (an
 * alias included), called with `program` and a table name bound to exactly one
 * unexported top-level `const` array literal of literal-usage entries. Any
 * other live form (a namespace or same-named declarer, a computed, spread,
 * shared or empty table, a non-literal usage) is refused with an error rather
 * than read as no commands, so the baseline and the check cannot silently miss
 * a command. A table that is never passed to the declarer, a subcommand
 * group's table and text that only mentions the declarer are not commands.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { allocationOf, derivePublicFacade, isPublicAllocation, originOf, originsOf, parseFacade } from "./facades.mjs";

const ts = createRequire(import.meta.url)("typescript");

/** The module that defines the lazy table declarer, repository-relative and without extension. */
const LAZY_COMMANDS_MODULE = "src/cli/lazy-commands";

/** The name that module exports the declarer under. */
const LAZY_DECLARER = "declareLazyCommands";

/** The fields of one lazy table entry: usage, description, loader. */
const LAZY_ENTRY_FIELDS = 3;

/** A top-level command name: the first word of a lazy entry's usage. */
const COMMAND_NAME = /^[a-z][a-z0-9-]*$/u;

/** The first word of a call's first string-literal argument, or `null`. */
function firstWordOfLiteral(call) {
  const [first] = call.arguments;
  return first !== undefined && ts.isStringLiteralLike(first) ? first.text.split(/\s+/u)[0] : null;
}

/**
 * Top-level command registrations in one module's text: legacy
 * `program.command("name …")` calls, then the entries of every table the
 * module passes to `declareLazyCommands(program, TABLE)`. Throws when such a
 * live table is in a form this reader does not support.
 *
 * @param fileName - The module's repository-relative path; it resolves the
 *   module's import of `src/cli/lazy-commands`.
 */
export function programCommandsOf(text, fileName = "module.ts") {
  const legacy = callNamesOf(text, fileName, (call) => call.expression.name.text === "command"
    && ts.isIdentifier(call.expression.expression) && call.expression.expression.text === "program");
  return [...legacy, ...lazyProgramCommandsOf(ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true), fileName)];
}

/** `registerTool("name", …)` registrations in one module's text. */
export function registeredToolsOf(text, fileName = "module.ts") {
  return callNamesOf(text, fileName, (call) => call.expression.name.text === "registerTool");
}

/** The first literal word of every `<object>.<method>(…)` call in one module's text that `isCall` accepts. */
function callNamesOf(text, fileName, isCall) {
  const names = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && isCall(node)) {
      const name = firstWordOfLiteral(node);
      if (name !== null) names.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true));
  return names;
}

/** Stop reading a module whose live top-level command table is in an unsupported form. */
function refuseLazyTable(fileName, reason) {
  throw new Error(`${fileName}: unsupported top-level lazy command table: ${reason}`);
}

/** Whether a module specifier written in `fileName` names the lazy-commands module. */
function isLazyCommandsModule(fileName, specifier) {
  return specifier.startsWith(".") && path.posix.join(path.posix.dirname(fileName), specifier).replace(/\.(?:js|ts)$/u, "") === LAZY_COMMANDS_MODULE;
}

/**
 * The local names a module binds to the declarer by a named import of the
 * lazy-commands module, an alias included. A default or namespace import of
 * that module is refused: calls through it could not be told apart.
 */
function lazyDeclarerBindings(sourceFile, fileName) {
  const bindings = new Set();
  for (const statement of sourceFile.statements.filter((candidate) => importsLazyCommands(candidate, fileName))) {
    if (bindsDefaultOrNamespace(statement.importClause)) refuseLazyTable(fileName, "a default or namespace import of the lazy-commands module");
    for (const name of declarerNamesOf(statement.importClause)) bindings.add(name);
  }
  return bindings;
}

/** Whether a top-level statement is an import of the lazy-commands module by a string specifier. */
function importsLazyCommands(statement, fileName) {
  return ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && isLazyCommandsModule(fileName, statement.moduleSpecifier.text);
}

/** Whether an import clause binds a default import or a namespace import (the forms this reader refuses). */
function bindsDefaultOrNamespace(clause) {
  return clause?.name !== undefined || (clause?.namedBindings !== undefined && !ts.isNamedImports(clause.namedBindings));
}

/** The local names an import clause gives the declarer through its named bindings, an alias included. */
function declarerNamesOf(clause) {
  const elements = clause?.namedBindings?.elements ?? [];
  return elements.filter((element) => (element.propertyName ?? element.name).text === LAZY_DECLARER).map((element) => element.name.text);
}

/** Whether a call goes to the imported declarer; a same-named call through any other binding is refused. */
function isLazyDeclarerCall(call, bindings, fileName) {
  const callee = call.expression;
  if (ts.isIdentifier(callee) && bindings.has(callee.text)) return true;
  const calleeName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
  if (calleeName === LAZY_DECLARER) refuseLazyTable(fileName, `${LAZY_DECLARER} is called through a binding that is not its named import`);
  return false;
}

/** Whether a declarer call declares top-level commands: its group is the identifier `program` (as in the legacy form). */
function declaresOnProgram(call, fileName) {
  const [group] = call.arguments;
  if (group === undefined || !ts.isIdentifier(group)) refuseLazyTable(fileName, "the group argument of a declarer call is not an identifier");
  return group.text === "program";
}

/** Whether an occurrence of the declarer binding is its import or the callee of a direct call. */
function isImportOrDirectCall(identifier) {
  const { parent } = identifier;
  return ts.isImportSpecifier(parent) || (ts.isCallExpression(parent) && parent.expression === identifier);
}

/**
 * The declarer calls of a module that declare top-level commands. Any other
 * use of the declarer binding (stored, passed, shadowed) is refused, so the
 * declarer cannot be reached through a name this reader does not see.
 */
function lazyProgramCalls(sourceFile, fileName) {
  const bindings = lazyDeclarerBindings(sourceFile, fileName);
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && isLazyDeclarerCall(node, bindings, fileName) && declaresOnProgram(node, fileName)) calls.push(node);
    if (ts.isIdentifier(node) && bindings.has(node.text) && !isImportOrDirectCall(node)) refuseLazyTable(fileName, `${node.text} is used other than as a direct call`);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

/** How many identifiers in a module are spelled `name` (comments and string contents are not identifiers). */
function identifierCount(sourceFile, name) {
  let count = 0;
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === name) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

/** Whether a variable statement is an unexported `const` (not `let`, `var` or `using`). */
function isUnexportedConst(statement) {
  const exported = (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  return !exported && (statement.declarationList.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const;
}

/**
 * The array literal a table name is bound to: exactly one unexported
 * top-level `const` declaration, referenced nowhere but there and in the one
 * declarer call, so nothing can replace, extend or reorder it unseen.
 */
function soleTableLiteral(sourceFile, name, fileName) {
  const found = sourceFile.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations.map((declaration) => ({ statement, declaration })))
    .filter(({ declaration }) => ts.isIdentifier(declaration.name) && declaration.name.text === name);
  if (found.length !== 1) refuseLazyTable(fileName, `${name} is not declared exactly once at the top level`);
  const [{ statement, declaration }] = found;
  if (!isUnexportedConst(statement)) refuseLazyTable(fileName, `${name} is not an unexported const`);
  if (identifierCount(sourceFile, name) !== 2) refuseLazyTable(fileName, `${name} is referenced other than by its declaration and one declarer call`);
  const { initializer } = declaration;
  if (initializer === undefined || !ts.isArrayLiteralExpression(initializer) || initializer.elements.length === 0) {
    refuseLazyTable(fileName, `${name} is not initialised with a non-empty array literal`);
  }
  return initializer;
}

/** The command name of one table entry: the first word of its literal usage. */
function entryCommandName(entry, fileName) {
  if (!ts.isArrayLiteralExpression(entry) || entry.elements.length !== LAZY_ENTRY_FIELDS) refuseLazyTable(fileName, "an entry is not a [usage, description, load] array literal");
  const [usage] = entry.elements;
  if (!ts.isStringLiteralLike(usage)) refuseLazyTable(fileName, "an entry's usage is not a string literal");
  const name = usage.text.split(/\s+/u)[0];
  if (!COMMAND_NAME.test(name)) refuseLazyTable(fileName, `usage ${JSON.stringify(usage.text)} does not begin with a command name`);
  return name;
}

/** The command names, in table order, of every table a module passes to the declarer with `program`. */
function lazyProgramCommandsOf(sourceFile, fileName) {
  return lazyProgramCalls(sourceFile, fileName).flatMap((call) => {
    const [, table] = call.arguments;
    if (call.arguments.length !== 2 || !ts.isIdentifier(table)) refuseLazyTable(fileName, "the table argument of a declarer call is not one identifier");
    return soleTableLiteral(sourceFile, table.text, fileName).elements.map((entry) => entryCommandName(entry, fileName));
  });
}

/** The names one facade statement exports: `*` for a star export. */
function exportedNamesOf(statement) {
  return statement.star ? ["*"] : statement.elements.map((element) => element.name);
}

/** Where a facade's exported name comes from: the core origin, the internal facade's origin, or the statement's own specifier. */
function originResolver(root, internal, publicFacade, coreOrigins) {
  const internalOrigins = originsOf(root, internal);
  return (name, specifier) => coreOrigins?.get(name) ?? internalOrigins.get(name) ?? originOf(publicFacade, specifier);
}

/**
 * The allocation violations of a facade's export statements, in statement
 * order, and every name they export. `facade` names the facade file (`path`)
 * and resolves each name's origin (`originFor`).
 */
function allocationViolations(surface, known, statements, facade) {
  const violations = [];
  const exported = new Set();
  for (const statement of statements) {
    for (const name of exportedNamesOf(statement)) {
      exported.add(name);
      const origin = facade.originFor(name, statement.specifier);
      const allocation = allocationOf(surface, known, name, origin);
      if (!isPublicAllocation(allocation)) violations.push({ facade: facade.path, name, origin, allocation });
    }
  }
  return { violations, exported };
}

/** Violations of one checked-in public facade: out of date, then unsupported forms, then unallocated exports. */
function facadeViolations(root, surface, baseline, key, coreOrigins) {
  const { internal, public: publicFacade } = surface.facades[key];
  if (!existsSync(path.join(root, publicFacade))) return { violations: [{ facade: publicFacade, name: "(file)", allocation: "public-facade-missing" }], missing: [] };
  const text = readFileSync(path.join(root, publicFacade), "utf8");
  const violations = [];
  // A tree whose facade is its own source (internal equals public) has nothing to derive from: only allocation and retention are checked.
  if (internal !== publicFacade && text !== derivePublicFacade(root, surface, baseline, key, coreOrigins)) violations.push({ facade: publicFacade, name: "(file)", allocation: "public-facade-out-of-date" });
  const { statements, unsupported } = parseFacade(text, publicFacade);
  violations.push(...unsupported.map((form) => ({ facade: publicFacade, name: form, allocation: "unsupported-export-form" })));
  const known = new Set(baseline.exports[key]);
  const allocated = allocationViolations(surface, known, statements, { path: publicFacade, originFor: originResolver(root, internal, publicFacade, coreOrigins) });
  violations.push(...allocated.violations);
  return { violations, missing: [...known].filter((name) => !allocated.exported.has(name)).sort() };
}

/** Violations of a registered-name surface (CLI commands or MCP tools). */
function registrationViolations(kind, registered, baselineNames, isAddition, excluded) {
  const known = new Set(baselineNames);
  const unique = [...new Set(registered)].sort();
  const violations = unique.filter((name) => !known.has(name) && !isAddition(name)).map((name) => ({ kind, name, allocation: excluded[name] ?? "unallocated" }));
  return { violations, missing: baselineNames.filter((name) => !unique.includes(name)), registered: unique };
}

/** Names `collect` finds across the reachable modules under the given source prefixes. */
function reachableNames(root, reachable, prefixes, collect) {
  const modules = reachable.filter((module) => prefixes.some((prefix) => (prefix.endsWith("/") ? module.startsWith(prefix) : module === prefix)));
  return modules.flatMap((module) => collect(readFileSync(path.join(root, module), "utf8"), module));
}

/**
 * Imports that name something a public facade does not export: the public
 * composition would fail to link against the public package.
 */
function linkViolations(root, manifest, graph) {
  const exportsOf = new Map(Object.values(manifest.surface.facades).map((facade) => [facade.public, new Set(originsOf(root, facade.public).keys())]));
  const violations = [];
  for (const [module, edges] of graph) {
    for (const edge of edges.filter((candidate) => candidate.viaPackage !== null && exportsOf.has(candidate.target))) {
      const absent = edge.names.filter((name) => name !== "*" && !exportsOf.get(edge.target).has(name));
      if (absent.length > 0) violations.push({ kind: "link", name: absent.join(", "), allocation: "imports-name-absent-from-public-facade", module, package: edge.viaPackage });
    }
  }
  return violations;
}

/**
 * Check the public facades, and the commands and tools the public CLI reaches.
 *
 * @param reachableFromCli - Modules runtime-reachable from the public CLI entry.
 * @param graph - The public composition's import graph.
 */
export function checkSurface(root, manifest, baseline, reachableFromCli, graph) {
  const { surface } = manifest;
  const coreOrigins = originsOf(root, surface.facades.core.internal);
  const facades = Object.keys(surface.facades).map((key) => [key, facadeViolations(root, surface, baseline, key, key === "root" ? coreOrigins : null)]);
  const cli = registrationViolations("cli", reachableNames(root, reachableFromCli, surface.cli.sources, programCommandsOf), baseline.cliCommands,
    (name) => surface.cli.scalingAdditions.includes(name), surface.cli.excluded);
  const mcp = registrationViolations("mcp", reachableNames(root, reachableFromCli, surface.mcp.sources, registeredToolsOf), baseline.mcpTools,
    (name) => surface.mcp.scalingAdditionPrefixes.some((prefix) => name.startsWith(prefix)), surface.mcp.excluded);
  return {
    violations: [...facades.flatMap(([, result]) => result.violations), ...cli.violations, ...mcp.violations, ...linkViolations(root, manifest, graph)],
    missingBaseline: { ...Object.fromEntries(facades.map(([key, result]) => [key, result.missing])), cli: cli.missing, mcp: mcp.missing },
    registered: { cliCommands: cli.registered, mcpTools: mcp.registered },
  };
}

/** The baseline a public source tree records: facade export names, CLI commands and MCP tools. */
export function baselineOf(readFile, listDir, facades) {
  const names = (file) => parseFacade(readFile(file), file).statements.flatMap((statement) => statement.elements.map((element) => element.name)).sort();
  const collect = (files, extract) => [...new Set(files.flatMap((file) => extract(readFile(file), file)))].sort();
  return {
    exports: Object.fromEntries(Object.entries(facades).map(([key, facade]) => [key, names(facade.internal)])),
    cliCommands: collect(["src/cli.ts", ...listDir("src/cli")], programCommandsOf),
    mcpTools: collect(listDir("src/mcp"), registeredToolsOf),
  };
}
