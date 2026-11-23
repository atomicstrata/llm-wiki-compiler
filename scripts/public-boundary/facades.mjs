/**
 * @file scripts/public-boundary/facades.mjs
 * @description Reading facade modules and deriving the explicit PUBLIC facades.
 *
 * A facade is a module made only of `export … from` statements (named,
 * star and `* as name` forms). It is read
 * with the installed TypeScript compiler's AST; any other export form is
 * reported, never skipped. Each exported name is allocated by the recorded
 * public baseline, then by name, then by the first matching prefix of its
 * origin module. A public facade is the internal facade with every statement
 * narrowed to the names allocated public, written out as its own checked-in
 * file: the public composition is explicit source, and the gate fails when a
 * checked-in public facade differs from what the manifest derives.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const ts = createRequire(import.meta.url)("typescript");

/** The allocation that lets a non-baseline name into a public facade. */
const PUBLIC_ADDITION = "public-scaling-addition";

/**
 * The export statements of one facade.
 *
 * @returns `statements` (`{ specifier, typeOnly, star, elements }`) and
 *   `unsupported`: the text of every export the facade model does not cover.
 */
export function parseFacade(text, fileName = "facade.ts") {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const statements = [];
  const unsupported = [];
  for (const node of sourceFile.statements) {
    const isExported = ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && (node.exportClause === undefined || ts.isNamedExports(node.exportClause))) {
      const elements = node.exportClause === undefined ? [] : node.exportClause.elements.map((element) => ({
        name: element.name.text, source: (element.propertyName ?? element.name).text, typeOnly: node.isTypeOnly || element.isTypeOnly,
      }));
      statements.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly, star: node.exportClause === undefined, namespace: false, elements });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isNamespaceExport(node.exportClause)) {
      // `export * as name from "…"`: one exported name bound to the whole module.
      const elements = [{ name: node.exportClause.name.text, source: "*", typeOnly: node.isTypeOnly }];
      statements.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly, star: false, namespace: true, elements });
    } else if (ts.isExportDeclaration(node) || ts.isExportAssignment(node) || isExported) {
      unsupported.push(node.getText(sourceFile).split("\n")[0].slice(0, 120));
    }
  }
  return { statements, unsupported };
}

/** A facade-relative specifier as a repository-relative origin (extension dropped); packages unchanged. */
export function originOf(facade, specifier) {
  if (!specifier.startsWith(".")) return specifier;
  return path.posix.join(path.posix.dirname(facade), specifier).replace(/\.js$/u, "");
}

/** Whether a top-level statement carries the `export` modifier. */
function hasExportModifier(node) {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

/**
 * The names one top-level statement of a star-exported module makes
 * available: the elements of a named re-export, the declarations of an
 * exported variable statement, or an exported declaration's own name.
 */
function statementExportNames(node, sourceFile) {
  if (ts.isExportDeclaration(node) && node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) return node.exportClause.elements.map((element) => element.name.text);
  if (!hasExportModifier(node)) return [];
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.map((declaration) => declaration.name.getText(sourceFile));
  return node.name !== undefined ? [node.name.text] : [];
}

/** Names a star-exported module makes available: its own exported declarations and named re-exports. */
function starNames(root, origin) {
  const text = readFileSync(path.join(root, `${origin}.ts`), "utf8");
  const sourceFile = ts.createSourceFile(`${origin}.ts`, text, ts.ScriptTarget.ES2022, true);
  return sourceFile.statements.flatMap((node) => statementExportNames(node, sourceFile));
}

/** Where every name a facade exports comes from, star exports included. */
export function originsOf(root, facade) {
  const { statements } = parseFacade(readFileSync(path.join(root, facade), "utf8"), facade);
  const origins = new Map();
  for (const statement of statements.filter((entry) => !entry.star)) {
    for (const element of statement.elements) origins.set(element.name, originOf(facade, statement.specifier));
  }
  for (const statement of statements.filter((entry) => entry.star)) {
    const origin = originOf(facade, statement.specifier);
    for (const name of starNames(root, origin)) if (!origins.has(name)) origins.set(name, origin);
  }
  return origins;
}

/** The allocation of one export: baseline, then by name, then by its origin's first matching prefix. */
export function allocationOf(surface, baselineNames, name, origin) {
  if (baselineNames.has(name)) return "public-baseline";
  const byName = surface.nameAllocations[name];
  if (byName !== undefined) return byName.allocation;
  const rule = surface.moduleAllocations.find((entry) => origin.startsWith(entry.prefix));
  return rule === undefined ? "unallocated" : rule.allocation;
}

/** Whether an allocation may appear in a public facade. */
export function isPublicAllocation(allocation) {
  return allocation === "public-baseline" || allocation === PUBLIC_ADDITION;
}

/** One element as export-clause text. */
function elementText(element, statementTypeOnly) {
  const renamed = element.source === element.name ? element.name : `${element.source} as ${element.name}`;
  return element.typeOnly && !statementTypeOnly ? `type ${renamed}` : renamed;
}

/** A specifier of the internal facade as seen from the public facade's directory. */
function publicSpecifier(internalFacade, publicFacade, specifier) {
  if (!specifier.startsWith(".")) return specifier;
  const target = path.posix.join(path.posix.dirname(internalFacade), specifier);
  const relative = path.posix.relative(path.posix.dirname(publicFacade), target);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/** The fixed header of the public facade derived from `internal`. */
function facadeHeader(internal, publicFacade) {
  return [
    "/**", ` * @file ${publicFacade}`,
    ` * @description PUBLIC RELEASE FACADE, derived from \`${internal}\` by`,
    " * `node scripts/check-public-boundary.mjs --write-public-facades`. It exports the",
    " * recorded public baseline plus the names `scripts/public-boundary/manifest.json`",
    " * allocates `public-scaling-addition`, and nothing else. Do not edit by hand:",
    " * change the manifest (a release decision) and regenerate. The release gate",
    " * fails when this file differs from what the manifest derives.", " */", "",
  ];
}

/**
 * Where one internal statement points from the public facade. An internal
 * augmentation of a public module is replaced by that public module: `origin`
 * allocates a star export, while named exports are still allocated one by one
 * by `internalOrigin`.
 */
function publicTargetOf(internal, publicFacade, specifier, overrides) {
  const internalOrigin = originOf(internal, specifier);
  const replaced = overrides[internalOrigin];
  const target = replaced === undefined ? specifier : `${path.posix.relative(path.posix.dirname(internal), replaced)}.js`.replace(/^(?!\.)/u, "./");
  return { internalOrigin, origin: replaced ?? internalOrigin, specifier: publicSpecifier(internal, publicFacade, target) };
}

/**
 * One statement as public-facade text, narrowed to the names `isPublic`
 * allows, or `null` when none is allowed.
 *
 * @param coreOrigins - For the root facade: each core-package name's true origin.
 */
function publicStatementText(statement, target, isPublic, coreOrigins) {
  const typeKeyword = statement.typeOnly ? "type " : "";
  if (statement.star) return isPublic("*", target.origin) ? `export ${typeKeyword}* from "${target.specifier}";` : null;
  const kept = statement.elements.filter((element) => isPublic(element.name, coreOrigins?.get(element.name) ?? target.internalOrigin));
  if (kept.length === 0) return null;
  if (statement.namespace) return `export ${typeKeyword}* as ${kept[0].name} from "${target.specifier}";`;
  const body = kept.map((element) => elementText(element, statement.typeOnly)).join(", ");
  return `export ${typeKeyword}{ ${body} } from "${target.specifier}";`;
}

/**
 * The text of the public facade the manifest derives from an internal one.
 *
 * @param coreOrigins - For the root facade: where each core-package name
 *   really comes from, so a re-export is allocated by its true origin.
 */
export function derivePublicFacade(root, surface, baseline, key, coreOrigins = null) {
  const { internal, public: publicFacade } = surface.facades[key];
  const { statements, unsupported } = parseFacade(readFileSync(path.join(root, internal), "utf8"), internal);
  if (unsupported.length > 0) throw new Error(`${internal} has export forms the public facade cannot be derived from: ${unsupported.join(" | ")}`);
  const known = new Set(baseline.exports[key]);
  const isPublic = (name, origin) => isPublicAllocation(allocationOf(surface, known, name, origin));
  const overrides = surface.publicSpecifierOverrides?.map ?? {};
  const lines = facadeHeader(internal, publicFacade);
  for (const statement of statements) {
    const text = publicStatementText(statement, publicTargetOf(internal, publicFacade, statement.specifier, overrides), isPublic, coreOrigins);
    if (text !== null) lines.push(text);
  }
  return `${lines.join("\n")}\n`;
}
