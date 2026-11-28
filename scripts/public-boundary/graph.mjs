/**
 * @file scripts/public-boundary/graph.mjs
 * @description The fail-closed source import graph behind the public release gate.
 *
 * Every module is parsed with the installed TypeScript compiler's AST, never a
 * regular expression. From each entry the graph follows static imports and
 * re-exports (type-only ones kept apart: they reach declarations but not
 * runtime chunks), literal dynamic `import()` and literal `require()`.
 *
 * It refuses, as a PROBLEM the gate fails on, everything it cannot follow:
 * a missing entry, a relative or in-repository specifier that resolves to no
 * file, a non-literal `import()` or `require()`, and any `createRequire`,
 * `import x = require()`, and any binding of `createRequire` (under any local
 * name, or through the `module` namespace). A legitimate case is admitted only
 * by an allowlist entry naming the file, the construct and the EXACT source
 * expression, with the reason. Nothing is ignored by default. This is an AST
 * rule over what the source says, not a sandbox: it does not prove what an
 * allowlisted expression loads at run time.
 *
 * An allowlist entry may also carry `sourceSha256`, the SHA-256 of the whole
 * module's raw bytes. When it is present it must be 64 lower-case hex digits
 * equal to the bytes read now, or the entry admits nothing. For the modules in
 * {@link HASH_PINNED_MODULES} it is REQUIRED: an entry for one of them without
 * a valid, equal hash admits nothing, so a changed module loses its exception.
 * Entries for other modules keep the file/construct/expression rule unchanged.
 *
 * Calls of the canonical on-demand loader (`requireOnUse`, see
 * `on-demand-loads.mjs`) are followed too: each supported literal load is a
 * runtime edge or outside package, resolved from the LOADER's location as
 * Node's `createRequire` there resolves it. Every unsupported use of the loader
 * is a problem that no allowlist entry can admit.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ON_DEMAND_LOADER, onDemandLoadsOf } from "./on-demand-loads.mjs";

const ts = createRequire(import.meta.url)("typescript");

/** Extensions tried, in order, for a specifier written without one or with `.js`. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"];

/** Whether `file` (repository-relative) is an existing regular file. */
function isFile(root, file) {
  const absolute = path.join(root, file);
  if (!existsSync(absolute)) return false;
  const relative = path.relative(realpathSync(root), realpathSync(absolute));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && statSync(absolute).isFile();
}

/** The candidates a relative specifier may resolve to, most specific first. */
function candidatesOf(base) {
  const stem = base.replace(/\.(?:js|mjs|cjs)$/u, "");
  const rewritten = SOURCE_EXTENSIONS.map((extension) => `${stem}${extension}`);
  return [base, ...rewritten, ...SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`)];
}

/** Whether a package name must resolve inside this repository. */
function isRepositoryPackage(specifier, config) {
  return config.inRepositoryPackages.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/** Resolve an absolute or outside-package specifier; null means a relative path. */
function nonRelativeResolution(specifier) {
  if (specifier.startsWith("/")) return { unresolved: true };
  if (!specifier.startsWith(".")) return { external: specifier };
  return null;
}

/** Whether a normalized relative path escaped the repository. */
function escapesRepository(base) {
  return base === ".." || base.startsWith("../") || path.posix.isAbsolute(base);
}

/** Resolve a relative specifier to a repository file or an unresolved edge. */
function relativeResolution(root, importer, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (escapesRepository(base)) return { unresolved: true };
  const target = candidatesOf(base).find((candidate) => isFile(root, candidate));
  return target === undefined ? { unresolved: true } : { target };
}

/**
 * Resolve one specifier from `importer`.
 *
 * @returns `{ target }` for a repository module, `{ external }` for an
 *   outside package or Node built-in, or `{ unresolved }` for a relative or
 *   in-repository specifier that names no file.
 */
function resolveSpecifier(root, importer, specifier, config) {
  if (config.packageEntries[specifier] !== undefined) return { target: config.packageEntries[specifier], viaPackage: specifier };
  if (isRepositoryPackage(specifier, config)) return { unresolved: true };
  return nonRelativeResolution(specifier) ?? relativeResolution(root, importer, specifier);
}

/** Whether a non-empty list of named import or export elements is entirely type-only. */
function allTypeOnly(elements) {
  return elements.length > 0 && elements.every((element) => element.isTypeOnly);
}

/** Whether an export declaration contributes no runtime edge: `export type`, or only type-only named elements. */
function isTypeOnlyExport(node) {
  return node.isTypeOnly || (node.exportClause !== undefined && ts.isNamedExports(node.exportClause) && allTypeOnly(node.exportClause.elements));
}

/** Whether an import declaration contributes no runtime edge: `import type`, or no default and only type-only named elements. */
function isTypeOnlyImport(node) {
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  return clause.name === undefined && clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) && allTypeOnly(clause.namedBindings.elements);
}

/** Whether an import or export declaration contributes no runtime edge. */
function isTypeOnlyDeclaration(node) {
  return ts.isExportDeclaration(node) ? isTypeOnlyExport(node) : isTypeOnlyImport(node);
}

/** The names an import declaration takes from its module; `*` stands for a default or namespace import. */
function importedNames(node) {
  if (!ts.isImportDeclaration(node) || node.importClause === undefined) return [];
  const { name, namedBindings } = node.importClause;
  const named = namedBindings !== undefined && ts.isNamedImports(namedBindings) ? namedBindings.elements.map((element) => (element.propertyName ?? element.name).text) : [];
  return name !== undefined || (namedBindings !== undefined && !ts.isNamedImports(namedBindings)) ? ["*", ...named] : named;
}

/** The string a call's first argument is when it is a plain string literal, else `null`. */
function literalArgument(call) {
  const [first] = call.arguments;
  return first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) ? first.text : null;
}

/** Classify one call expression: a dynamic import, a `require`, a `createRequire`, or nothing. */
function classifyCall(node) {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return { construct: "dynamic-import", specifier: literalArgument(node), kind: "dynamic" };
  if (ts.isIdentifier(node.expression) && node.expression.text === "require") return { construct: "require", specifier: literalArgument(node), kind: "runtime" };
  const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : "";
  return callee === "createRequire" ? { construct: "createRequire", specifier: undefined } : null;
}

/** Whether an import declaration binds `createRequire` under any local name, or the whole `module` namespace. */
function bindsCreateRequire(node) {
  if (!ts.isImportDeclaration(node) || !["module", "node:module"].includes(node.moduleSpecifier.text) || node.importClause === undefined) return false;
  const { name, namedBindings } = node.importClause;
  if (name !== undefined || (namedBindings !== undefined && !ts.isNamedImports(namedBindings))) return true;
  return namedBindings !== undefined && namedBindings.elements.some((element) => (element.propertyName ?? element.name).text === "createRequire");
}

/** A static import or export declaration with a module specifier: a type or runtime edge, with the names it takes. */
function declarationReference(node, at) {
  if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || node.moduleSpecifier === undefined) return null;
  return { construct: "static", specifier: node.moduleSpecifier.text, kind: isTypeOnlyDeclaration(node) ? "type" : "runtime", line: at(node).line, names: importedNames(node) };
}

/** An import-equals declaration with an external module reference (the `import x = require` form): an unfollowable construct. */
function importEqualsReference(node, at) {
  if (!ts.isImportEqualsDeclaration(node) || !ts.isExternalModuleReference(node.moduleReference)) return null;
  return { construct: "import-equals-require", specifier: undefined, ...at(node) };
}

/** An import type node whose argument is a string literal type: a type edge. */
function importTypeReference(node, at) {
  if (!ts.isImportTypeNode(node) || !ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal)) return null;
  return { construct: "static", specifier: node.argument.literal.text, kind: "type", line: at(node).line };
}

/** A dynamic import or `require` call (a `createRequire` call is flagged through its binding, not here). */
function callReference(node, at) {
  if (!ts.isCallExpression(node)) return null;
  const classified = classifyCall(node);
  return classified !== null && classified.construct !== "createRequire" ? { ...classified, ...at(node) } : null;
}

/** The reference forms one node may make, tried in this order (the first match wins). */
const NODE_REFERENCES = [declarationReference, importEqualsReference, importTypeReference, callReference];

/**
 * The module reference one node itself makes, or null: a static import or
 * export declaration, an import-equals `require`, an import type node, or a
 * dynamic import or `require` call. `at` gives `{ line, expression }` of a node.
 */
function referenceOfNode(node, at) {
  for (const referenceOf of NODE_REFERENCES) {
    const reference = referenceOf(node, at);
    if (reference !== null) return reference;
  }
  return null;
}

/** Every import-like reference of one parsed file: `{ construct, specifier, kind, line, expression }`. */
function referencesOf(sourceFile) {
  const references = [];
  const at = (node) => ({ line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, expression: node.getText(sourceFile).replace(/\s+/gu, " ") });
  const visit = (node) => {
    // The binding itself is flagged, so `createRequire as anything` and `import * as m from "node:module"` cannot hide a require.
    if (bindsCreateRequire(node)) references.push({ construct: "createRequire", specifier: undefined, ...at(node) });
    const reference = referenceOfNode(node, at);
    if (reference !== null) references.push(reference);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

/**
 * Modules whose exceptions MUST carry the exact reviewed `sourceSha256`: the
 * canonical on-demand loader (its callers are traced, its body is trusted only
 * as reviewed) and the kernel start-time helper (an unchanged upstream
 * `bun:ffi` route admitted as source metadata only, not as native or runtime
 * approval). Omitting the hash for these modules admits nothing.
 */
const HASH_PINNED_MODULES = new Set([ON_DEMAND_LOADER.module, "src/utils/kernel-start-time.ts"]);

/** A SHA-256 written as 64 lower-case hex digits. */
const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** Whether an entry's source-hash condition admits the module whose raw bytes hash to `sourceSha256`. */
function sourceHashAdmits(entry, sourceSha256) {
  if (entry.sourceSha256 === undefined) return !HASH_PINNED_MODULES.has(entry.file);
  return typeof entry.sourceSha256 === "string" && SHA256_HEX.test(entry.sourceSha256) && entry.sourceSha256 === sourceSha256;
}

/**
 * Whether an allowlist entry admits this exact occurrence: the same file, the
 * same construct AND the same source expression, and, when the entry carries
 * a source hash (always, for a hash-pinned module), the same module bytes. A
 * second, different unfollowable expression in an allowlisted file is still a
 * problem.
 */
function isAllowed(config, module, reference, sourceSha256) {
  return config.allowedConstructs.some((entry) => entry.file === module && entry.construct === reference.construct
    && typeof entry.expression === "string" && entry.expression === reference.expression && sourceHashAdmits(entry, sourceSha256));
}

/**
 * What one reference of `module` is: `{ problem: reason }` when the graph
 * cannot follow it (unfollowable loading, a non-literal or unresolvable
 * specifier), `{ edge }` for a repository module, or `{ external }`.
 */
function classifyReference(root, module, reference, config) {
  if (reference.construct === "createRequire" || reference.construct === "import-equals-require") return { problem: "module loading the graph cannot follow" };
  if (reference.specifier === null) return { problem: "non-literal specifier" };
  const resolved = resolveSpecifier(root, module, reference.specifier, config);
  if (resolved.unresolved) return { problem: "relative or in-repository specifier resolves to no file" };
  if (resolved.target !== undefined) return { edge: { target: resolved.target, kind: reference.kind, viaPackage: resolved.viaPackage ?? null, names: reference.names ?? [] } };
  return { external: { specifier: resolved.external, kind: reference.kind } };
}

/**
 * Add what `module` loads through the canonical on-demand loader. Each literal
 * load is resolved FROM THE LOADER'S location (as Node's
 * `createRequire(import.meta.url)` there resolves it) into a runtime edge or an
 * outside package; a load that resolves to no file, and every refused use of
 * the loader, is a problem that no allowlist entry admits.
 */
function recordOnDemandLoads(result, root, module, sourceFile, config) {
  const resolvesToLoader = (specifier) => resolveSpecifier(root, module, specifier, config).target === ON_DEMAND_LOADER.module;
  const { loads, refusals } = onDemandLoadsOf(sourceFile, module, resolvesToLoader);
  for (const refusal of refusals) result.problems.push({ module, specifier: null, ...refusal });
  for (const load of loads) {
    const resolved = resolveSpecifier(root, ON_DEMAND_LOADER.module, load.specifier, config);
    if (resolved.unresolved) {
      result.problems.push({ module, line: load.line, construct: load.construct, specifier: load.specifier, expression: load.expression,
        reason: "on-demand load resolves to no file from the loader's location" });
    } else if (resolved.target !== undefined) {
      result.edges.push({ target: resolved.target, kind: "runtime", viaPackage: resolved.viaPackage ?? null, names: ["*"] });
    } else {
      result.externals.push({ specifier: resolved.external, kind: "runtime" });
    }
  }
}

/** Edges, outside-package references and problems of one module (an allowlisted occurrence is not a problem). */
function analyseModule(root, module, config) {
  const result = { edges: [], externals: [], problems: [] };
  if (module.endsWith(".json")) return result;
  const bytes = readFileSync(path.join(root, module));
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  const sourceFile = ts.createSourceFile(module, bytes.toString("utf8"), ts.ScriptTarget.ES2022, true);
  for (const reference of referencesOf(sourceFile)) {
    const classified = classifyReference(root, module, reference, config);
    if (classified.edge !== undefined) result.edges.push(classified.edge);
    else if (classified.external !== undefined) result.externals.push(classified.external);
    else if (!isAllowed(config, module, reference, sourceSha256)) result.problems.push({ module, line: reference.line, construct: reference.construct, specifier: reference.specifier ?? null, expression: reference.expression ?? null, reason: classified.problem });
  }
  recordOnDemandLoads(result, root, module, sourceFile, config);
  return result;
}

/**
 * Build the graph reachable from `entries` (name → module), lazily and exhaustively.
 *
 * @returns `graph` (module → edges), `externals` (module → outside-package
 *   references) and `problems`: everything the graph could not follow. A
 *   caller must fail when `problems` is not empty.
 */
export function buildGraph(root, entries, config) {
  const graph = new Map();
  const externals = new Map();
  const problems = [];
  const queue = [];
  for (const [name, module] of Object.entries(entries)) {
    if (isFile(root, module)) queue.push(module);
    else problems.push({ module, line: 0, construct: "entry", specifier: null, reason: `entry ${name} does not exist` });
  }
  while (queue.length > 0) {
    const module = queue.shift();
    if (graph.has(module)) continue;
    const analysed = analyseModule(root, module, config);
    graph.set(module, analysed.edges);
    externals.set(module, analysed.externals);
    problems.push(...analysed.problems);
    for (const edge of analysed.edges) if (!graph.has(edge.target)) queue.push(edge.target);
  }
  return { graph, externals, problems };
}

/**
 * Breadth-first reachability from `entry`, following `kinds`; returns module → parent.
 *
 * @param withinPackage - When true, edges that cross into an in-repository
 *   package are not followed: the result is what one package itself bundles.
 */
export function reach(graph, entry, kinds, withinPackage = false) {
  const parent = new Map([[entry, null]]);
  const queue = [entry];
  while (queue.length > 0) {
    const module = queue.shift();
    for (const edge of graph.get(module) ?? []) {
      if (!kinds.includes(edge.kind) || parent.has(edge.target) || (withinPackage && edge.viaPackage !== null)) continue;
      parent.set(edge.target, module);
      queue.push(edge.target);
    }
  }
  return parent;
}

/** The import chain from the entry to `module`. */
export function chainTo(parent, module) {
  const chain = [];
  for (let current = module; current !== null && current !== undefined; current = parent.get(current)) chain.unshift(current);
  return chain;
}
