/**
 * @file test/preparation-service-boundary.test.ts
 * @description D-10-1 as a DERIVED structural control: every preparation surface
 * is an adapter over the one service, with no reach into the substrate and no
 * filesystem reach beside it.
 *
 * THE ADAPTER SET IS DERIVED, NOT LISTED. It is the two surface trees plus the
 * CLI registrar, walked from disk — so a new command module or a new SDK module
 * is covered the moment it exists. A hand-written file list is the exact shape
 * this program keeps finding defects behind: the list and the code drift, and
 * the control certifies whichever one it was given.
 *
 * WHAT THIS PROVES: no adapter imports a preparation module other than the
 * service, and no module of the preparation SURFACE that can invoke a
 * preparation operation can also open a path. The second half is what leaves
 * "reach the store from an adapter" with no module to live in —
 * `documents.ts` opens the operator's files and imports only TYPES, so it holds
 * no preparation behaviour to reach the store with, and every module that does
 * hold that behaviour imports no filesystem API.
 *
 * "Can invoke" is computed as a FIXPOINT over the TRANSITIVE CLOSURE of value
 * imports, not as a direct import of the service and not as one confined to the
 * surface set. Four independent evasions were proven against earlier versions of
 * this file, and each is now a named form in the code below:
 *
 *   1. two hops — the CLI commands reach the service through `host.ts`, so a
 *      direct-import check left `node:fs` in `fail.ts` green;
 *   2. a bridge — running the fixpoint only WITHIN the surface set let a
 *      re-export parked in `src/utils` carry the service across unseen;
 *   3. a dynamic `await import` — invisible to a top-level-statement walk, so an
 *      adapter reaching the substrate dynamically went unreported;
 *   4. `export … from` — a re-export is a value reach, so the fs-exempt module
 *      could hand the service constructor onward and stay exempt.
 *
 * SCOPE OF THE FILESYSTEM RULE, stated because overstating a control is the
 * defect class this corpus keeps finding: it covers `src/commands/preparation`
 * and `src/sdk` MINUS a named exemption list — an allowlist that fails closed,
 * so a new SDK module is covered the moment it exists. Only `src/sdk/core.ts` is
 * exempt, because its `node:fs` use is a root-is-a-directory check in the
 * general SDK composition root, predating preparations and unrelated to them.
 * The substrate-reach rule DOES cover all of `src/sdk` including the exemptions,
 * which is what stops any SDK module reaching the store directly.
 *
 * WHAT THIS CANNOT PROVE: that an adapter makes no *semantic* mistake with what
 * the service returns. That is a behavioural obligation, carried by the
 * subprocess and facade suites, and a green run here is not evidence about it.
 */

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  dynamicImportSpecifiers, importedSpecifiers, importsNodeFilesystem,
} from "./preparations/lifecycle-model/source-text.js";
import { listFilesUnder } from "./preparations/lifecycle-model/walk.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SERVICE = "src/preparations/service.ts";
const SOURCE_ALIASES: Record<string, string[]> = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "tsconfig.json"), "utf8"),
).compilerOptions.paths;
/** The CLI registrar lives among unrelated CLI files, so it is named. */
const CLI_REGISTRAR = "src/cli/preparation-commands.ts";

/**
 * Every module that adapts a preparation surface, DERIVED from the two surface
 * trees rather than restated. `src/sdk` is taken whole: no SDK module should
 * reach preparation substrate, whether or not it is the preparation facade.
 */
async function adapterModules(): Promise<string[]> {
  return [
    ...await listFilesUnder(REPO_ROOT, "src/commands/preparation", ".ts"),
    ...await listFilesUnder(REPO_ROOT, "src/sdk", ".ts"),
    CLI_REGISTRAR,
  ].sort();
}

/** One module's source, comments included — the parser ignores them anyway. */
async function sourceOf(module: string): Promise<string> {
  return readFile(path.join(REPO_ROOT, module), "utf8");
}

/** Resolve relative imports and the repository's real package aliases. */
function resolveSpecifier(module: string, specifier: string): string {
  const alias = SOURCE_ALIASES[specifier]?.[0];
  if (alias) return path.posix.normalize(alias);
  return path.posix.normalize(
    path.posix.join(path.posix.dirname(module), specifier.replace(/\.js$/u, ".ts")));
}

/** Every preparation module an adapter reaches that is not the service. */
async function substrateReaches(): Promise<string[]> {
  const offenders: string[] = [];
  for (const module of await adapterModules()) {
    for (const specifier of importedSpecifiers(module, await sourceOf(module))) {
      if (!specifier.startsWith(".") && !SOURCE_ALIASES[specifier]) continue;
      const resolved = resolveSpecifier(module, specifier);
      if (!resolved.startsWith("src/preparations/") || resolved === SERVICE) continue;
      offenders.push(`${module} -> ${resolved}`);
    }
  }
  return offenders;
}

/** True when an import clause brings in anything callable. */
function isValueImportClause(clause: ts.ImportClause | undefined): boolean {
  // A side-effect import has no clause at all and still executes the module.
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  const bindings = clause.namedBindings;
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

/**
 * Every module this one imports a VALUE from — anything it could call.
 *
 * The type/value distinction is what the rule turns on. `import type` erases at
 * compile time and carries no behaviour, so a module holding only those cannot
 * invoke anything it named.
 *
 * THREE FORMS, because two of them were evasions. An `export … from` re-export
 * is a value reach — the fs-exempt module could otherwise re-export the service
 * constructor and stay exempt while handing the constructor to everyone. And a
 * dynamic import is ALWAYS a value reach: there is no type-only form of it.
 */
function valueImportsOf(module: string, source: string): string[] {
  const parsed = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
  const reached: string[] = [];
  for (const statement of parsed.statements) {
    const specifier = valueSpecifierOf(statement);
    if (specifier !== undefined && (specifier.startsWith(".") || SOURCE_ALIASES[specifier])) {
      reached.push(resolveSpecifier(module, specifier));
    }
  }
  for (const specifier of dynamicImportSpecifiers(module, source)) {
    // The DYNAMIC ones only. Folding in `importedSpecifiers` wholesale was a
    // defect this control caught on itself: that helper returns static `import
    // type` specifiers too, so every type-only reach became a value edge and
    // `documents.ts` — which imports exactly one type from the service — was
    // classified as able to call an operation.
    if (specifier.startsWith(".") || SOURCE_ALIASES[specifier]) reached.push(resolveSpecifier(module, specifier));
  }
  return reached;
}

/** The specifier of one statement, when the statement reaches a VALUE. */
function valueSpecifierOf(statement: ts.Statement): string | undefined {
  if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
    return isValueImportClause(statement.importClause) ? statement.moduleSpecifier.text : undefined;
  }
  if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined
    && ts.isStringLiteral(statement.moduleSpecifier) && !statement.isTypeOnly) {
    return statement.moduleSpecifier.text;
  }
  return undefined;
}

/**
 * SDK modules the filesystem rule deliberately does not cover, NAMED.
 *
 * An allowlist that fails closed, not an inclusion list that fails open. The
 * previous version hardcoded the one facade it wanted to cover, so a ninth SDK
 * module importing the service AND `node:fs` was invisible with every test
 * green. Stating the exemption instead means a new module is covered by
 * default and removing its coverage is an edit somebody has to make on purpose.
 *
 * `core.ts` is exempt because its `node:fs` use is the root-is-a-directory check
 * in the general SDK composition root — it predates preparations and is
 * unrelated to them. That is the header's scope note, in the one place the
 * scope is actually decided.
 */
const FS_RULE_EXEMPT: readonly string[] = ["src/sdk/core.ts"];

/** The modules that ARE the preparation surface — see the file header's scope note. */
async function surfaceModules(): Promise<string[]> {
  const sdk = await listFilesUnder(REPO_ROOT, "src/sdk", ".ts");
  return [
    ...await listFilesUnder(REPO_ROOT, "src/commands/preparation", ".ts"),
    ...sdk.filter((module) => !FS_RULE_EXEMPT.includes(module)),
  ].sort();
}

/**
 * Value-import edges from every surface module, TRANSITIVELY.
 *
 * The closure is the fix for the second evasion. Running the fixpoint only over
 * the surface set meant a re-export bridge parked in `src/utils` defeated it:
 * the bridge is not a surface module, so no edge existed and the module reaching
 * the service through it was never classified as bearing. Reached-but-unlisted
 * modules need EDGES, not classification — they are traversed here and checked
 * nowhere.
 *
 * The walk stops at `src/preparations/`: the service is the terminal this graph
 * is looking for, and the rest of that tree is the substrate rule's business.
 */
async function behaviourGraph(): Promise<Map<string, string[]>> {
  const graph = new Map<string, string[]>();
  const queue = [...await surfaceModules()];
  while (queue.length > 0) {
    const module = queue.pop() as string;
    if (graph.has(module)) continue;
    const source = await sourceOf(module).catch(() => null);
    // A specifier that resolves to nothing readable (a package path, a `.json`,
    // a directory index) contributes no edges rather than failing the walk.
    if (source === null) { graph.set(module, []); continue; }
    const reaches = valueImportsOf(module, source);
    graph.set(module, reaches);
    for (const target of reaches) {
      if (target === SERVICE || target.startsWith("src/preparations/")) continue;
      if (!graph.has(target)) queue.push(target);
    }
  }
  return graph;
}

/**
 * Modules that can invoke a preparation operation, as a FIXPOINT over that graph.
 *
 * A module bears preparation behaviour when it can call the service directly OR
 * can call a module that can. One hop is not enough — the CLI commands reach the
 * service through `host.ts` — and neither is one hop plus surface membership.
 */
async function behaviourBearingModules(): Promise<Set<string>> {
  const graph = await behaviourGraph();
  const bearing = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [module, reaches] of graph) {
      if (bearing.has(module)) continue;
      if (!reaches.some((target) => target === SERVICE || bearing.has(target))) continue;
      bearing.add(module);
      changed = true;
    }
  }
  return bearing;
}

/**
 * Filesystem-rule exemptions that reach the SERVICE directly.
 *
 * The exemption buys freedom from the filesystem rule, not freedom to become a
 * conduit. Without this, the named exempt module could `export { … } from` the
 * service — handing the constructor to every consumer while holding `node:fs`
 * itself, and nothing checks it because it is exempt. Composing a facade is
 * allowed and is what `core.ts` legitimately does; reaching the service itself
 * is not, in any value form.
 */
async function exemptServiceConduits(): Promise<string[]> {
  const offenders: string[] = [];
  for (const module of FS_RULE_EXEMPT) {
    const reaches = valueImportsOf(module, await sourceOf(module));
    if (reaches.includes(SERVICE)) offenders.push(`${module} -> ${SERVICE}`);
  }
  return offenders;
}

/** The package's public entry point — what an npm consumer can reach. */
const PUBLIC_ENTRY = "src/index.ts";

/**
 * Service values the public entry point must never re-export.
 *
 * `createPreparationService` is withheld deliberately: a surface is built in
 * this repository by a host that supplies its own principal resolver, not
 * assembled by a consumer. Both `src/index.ts` and the service-authority suite
 * assert that in PROSE, and prose is not a control — exporting the constructor
 * left every structural check in this file green, because `src/index.ts` is in
 * neither the adapter set nor the surface set.
 */
const WITHHELD_FROM_PUBLIC_ENTRY: readonly string[] = ["createPreparationService"];

/** How deep a re-export chain this walk will follow before giving up. */
const MAX_REEXPORT_DEPTH = 8;

/** One `export … from` edge: where it points and which names travel along it. */
interface ReExportEdge {
  readonly target: string;
  /** `null` means `export *` — every name the target exports travels. */
  readonly names: readonly string[] | null;
}

/** Every value-carrying `export … from` edge one module declares. */
function reExportEdges(module: string, source: string): ReExportEdge[] {
  const parsed = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
  const edges: ReExportEdge[] = [];
  for (const statement of parsed.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    if (statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = resolveSpecifier(module, statement.moduleSpecifier.text);
    const clause = statement.exportClause;
    if (clause === undefined) { edges.push({ target, names: null }); continue; }
    if (!ts.isNamedExports(clause)) continue;
    edges.push({
      target,
      names: clause.elements
        .filter((element) => !element.isTypeOnly)
        .map((element) => (element.propertyName ?? element.name).text),
    });
  }
  return edges;
}

/**
 * The withheld names one module exports, following re-export chains.
 *
 * TRANSITIVE, and it must stay that way. The first version resolved only the
 * statement's OWN specifier, so `export * from "./bridge.js"` — where the
 * bridge re-exports the constructor — was invisible: every test in this file
 * stayed green while `createPreparationService` was a live function on
 * `dist/index.js`. That is evasion #2 from this file's own header, the bridge,
 * reintroduced in a control written after the header retired it for the surface
 * rule.
 *
 * KEEP THIS CONSISTENT WITH `behaviourGraph`. Both answer "what does this module
 * reach, through however many hops", and a fix applied to one of them that is
 * not applied to the other leaves the other one hop deep.
 */
async function withheldExportsOf(module: string, depth = MAX_REEXPORT_DEPTH): Promise<Set<string>> {
  const found = new Set<string>();
  if (depth === 0) return found;
  const source = await sourceOf(module).catch(() => null);
  if (source === null) return found;
  for (const edge of reExportEdges(module, source)) {
    const carried = edge.target === SERVICE
      ? new Set(WITHHELD_FROM_PUBLIC_ENTRY)
      : await withheldExportsOf(edge.target, depth - 1);
    for (const name of edge.names ?? carried) {
      if (carried.has(name)) found.add(name);
    }
  }
  return found;
}

/** Withheld service values the public entry point re-exports, at any depth. */
async function leakedPublicExports(): Promise<string[]> {
  return [...await withheldExportsOf(PUBLIC_ENTRY)].map((name) => `${PUBLIC_ENTRY} -> ${name}`);
}

/** Surface modules that can both call a preparation operation and open a path. */
async function filesystemReachingCallers(): Promise<string[]> {
  const bearing = await behaviourBearingModules();
  const offenders: string[] = [];
  for (const module of await surfaceModules()) {
    if (bearing.has(module) && importsNodeFilesystem(module, await sourceOf(module))) {
      offenders.push(module);
    }
  }
  return offenders;
}

describe("preparation surfaces are adapters over one service", () => {
  it("derives an adapter set containing every shipped surface module", async () => {
    // ANTI-VACUITY. Both controls below are "the offender list is empty", which
    // an empty adapter set satisfies perfectly. Pinning the known members means
    // a derivation that silently stopped finding files goes red here first.
    const modules = await adapterModules();
    expect(modules).toEqual(expect.arrayContaining([
      "src/cli/preparation-commands.ts",
      "src/commands/preparation/cancel.ts",
      "src/commands/preparation/documents.ts",
      "src/commands/preparation/fail.ts",
      "src/commands/preparation/gate.ts",
      "src/commands/preparation/host.ts",
      "src/commands/preparation/list.ts",
      // ADDED AS DISCOVERED MEMBERS with the pause slice. Both reach the service
      // through `host.ts`, so the two-hop fixpoint is what classifies them.
      "src/commands/preparation/pause.ts",
      "src/commands/preparation/prune.ts",
      "src/commands/preparation/recovery.ts",
      "src/commands/preparation/stage.ts",
      "src/commands/preparation/sweep.ts",
      "src/sdk/preparation-facade.ts",
      "src/sdk/wiki.ts",
    ]));
  });

  it("reaches no preparation module other than the service", async () => {
    expect(await substrateReaches()).toEqual([]);
  });

  it("names every filesystem-rule exemption, and keeps each one under the substrate rule", async () => {
    // The exemption is an ALLOWLIST, so it has to be visible and exact — an
    // unpinned one is a way to leave a control's scope rather than satisfy it.
    expect(FS_RULE_EXEMPT).toEqual(["src/sdk/core.ts"]);
    // And exempt from the FILESYSTEM rule is not exempt from everything: each
    // one is still an adapter, so it may still reach no preparation module but
    // the service.
    const adapters = await adapterModules();
    for (const exempt of FS_RULE_EXEMPT) expect(adapters).toContain(exempt);
    const surface = await surfaceModules();
    for (const exempt of FS_RULE_EXEMPT) expect(surface).not.toContain(exempt);
  });

  it("withholds the service constructor from the public entry point", async () => {
    // The prose in `src/index.ts` and in the service-authority suite both say
    // the constructor is withheld. Until now nothing checked it: `src/index.ts`
    // is in neither the adapter set nor the surface set, so exporting
    // `createPreparationService` from it left this whole file green.
    expect(await leakedPublicExports()).toEqual([]);
    // ANTI-VACUITY: follow the standard facade into core, then the service.
    const source = await sourceOf(PUBLIC_ENTRY);
    expect(importedSpecifiers(PUBLIC_ENTRY, source)
      .some((specifier) => resolveSpecifier(PUBLIC_ENTRY, specifier) === "src/core-index.ts")).toBe(true);
    expect(importedSpecifiers("src/core-index.ts", await sourceOf("src/core-index.ts"))
      .some((specifier) => resolveSpecifier("src/core-index.ts", specifier) === SERVICE)).toBe(true);
  });

  it("lets no filesystem-rule exemption become a conduit to the service", async () => {
    // Exempt from the filesystem rule is not exempt from being a surface. A
    // module that both holds `node:fs` and re-exports the service constructor
    // would otherwise be the one place the boundary has no owner.
    expect(await exemptServiceConduits()).toEqual([]);
  });

  it("classifies every operation-invoking surface module as behaviour-bearing", async () => {
    // The filesystem rule is a CONJUNCTION, so it also passes vacuously if the
    // fixpoint decides nothing bears behaviour. This pins the other half of it,
    // INCLUDING the two-hop members — `fail`/`list`/`stage` reach the service
    // only through `host.ts`, and a one-hop check left them unclassified.
    expect([...await behaviourBearingModules()].sort()).toEqual([
      "src/commands/preparation/cancel.ts",
      "src/commands/preparation/fail.ts",
      "src/commands/preparation/gate.ts",
      "src/commands/preparation/host.ts",
      "src/commands/preparation/list.ts",
      // ADDED AS DISCOVERED MEMBERS with the pause slice. Both reach the service
      // through `host.ts`, so the two-hop fixpoint is what classifies them.
      "src/commands/preparation/pause.ts",
      "src/commands/preparation/prune.ts",
      "src/commands/preparation/recovery.ts",
      // A DISCOVERED MEMBER with the reset slice, and the only one whose service
      // operation no SDK module can reach. It is here for the same structural
      // reason as its siblings — it reaches the service through `host.ts`, so
      // the two-hop fixpoint classifies it — and being CLI-only changes nothing
      // about that: the boundary rule is that an adapter reaches the service and
      // no other preparation module, which is a claim about imports rather than
      // about exposure.
      "src/commands/preparation/reset.ts",
      "src/commands/preparation/resume.ts",
      "src/commands/preparation/show.ts",
      "src/commands/preparation/stage.ts",
      "src/commands/preparation/sweep.ts",
      // DISCOVERED MEMBERS with the WOP V3 product vertical. The product service
      // invokes the preparation service's `preview`/`stage` to run an activated
      // pack action, and its SDK facade reaches it through the fixpoint. The
      // service ALSO drives the runner (deliberately outside the frozen service),
      // so it is not an adapter over the one service and correctly sits outside
      // the substrate-reach rule's `src/commands/preparation` + `src/sdk` scope;
      // the facade IS in that scope and reaches no preparation module directly.
      "src/products/service.ts",
      "src/sdk/compiler-composition.ts",
      "src/sdk/core.ts",
      "src/sdk/preparation-facade.ts",
      "src/sdk/product-facade.ts",
      "src/sdk/wiki.ts",
    ]);
  });

  it("exercises the exemption rather than assuming it", async () => {
    // The rule only has content because ONE surface module genuinely opens
    // paths. If `documents.ts` stopped using the filesystem, the rule below
    // would hold trivially and this says so out loud.
    const source = await sourceOf("src/commands/preparation/documents.ts");
    expect(importsNodeFilesystem("src/commands/preparation/documents.ts", source)).toBe(true);
    expect(await behaviourBearingModules())
      .not.toContain("src/commands/preparation/documents.ts");
  });

  it("lets no surface module both call the service and open a path", async () => {
    expect(await filesystemReachingCallers()).toEqual([]);
  });
});
