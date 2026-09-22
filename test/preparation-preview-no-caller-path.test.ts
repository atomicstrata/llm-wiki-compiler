/**
 * @file test/preparation-preview-no-caller-path.test.ts
 * @description The property that makes a GRANT-FREE `preview` safe: a caller
 * cannot hand it a filesystem path.
 *
 * WHY THIS CONTROL EXISTS, and it is a real exploit rather than a hypothetical.
 * The superseded thirteen-operation attempt at this service also made `preview`
 * grant-free, and its initial inputs carried a caller-supplied `sourceRoot` which
 * was ALSO the confinement root — so confinement was self-satisfied. An ungranted
 * SDK or MCP client could name any host path and read back an absent /
 * unavailable / oversize classification: an existence, readability and size
 * oracle over the whole filesystem, plus a content-hashing primitive. It was
 * recorded as the highest-priority open item of that line and the only
 * unauthorized-caller scenario in it.
 *
 * WHY IT CANNOT RECUR IN THIS DESIGN. The request carries DOCUMENTS AS TEXT
 * behind lazily-invoked readers: the CLI binds them to operator-named files it
 * opens itself, the SDK binds them to strings its embedder already holds, and the
 * service reaches no path a caller chose. The grant was standing in for that
 * property. The property is what is asserted here.
 *
 * WHAT GUARDS IT NOW. This control walks the request type with the TYPE CHECKER —
 * not a regex over the source, because the question is structural and this program
 * has watched four lexical instruments answer structural questions wrongly — and
 * pins the COMPLETE set of members reachable from `PreviewRequestV1`, each with
 * its type. Adding any field to any type in that closure fails it, including the
 * path-bearing one somebody adds in good faith three slices from now. An exact
 * set rather than a denylist of suspicious names: a denylist only refuses the
 * names its author thought of, and `sourceRoot` was not an obviously dangerous
 * name either.
 *
 * WHAT THIS DOES NOT PROVE. That no CODE PATH opens a path — the surfaces do open
 * files, which is their job. `preparation-service-boundary` owns that half: no
 * module that can invoke a preparation operation can also open a path. This one
 * owns the request SHAPE, which is the half a caller controls.
 */

import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SRC_PREFIX = path.join(REPO_ROOT, "src") + path.sep;
const SERVICE_STAGE = path.join(REPO_ROOT, "src/preparations/service-stage.ts");
const REQUEST_TYPE = "PreviewRequestV1";
/** Depth bound, so a cyclic request shape fails the assertion instead of hanging. */
const MAX_DEPTH = 8;

/**
 * Every member a caller can populate on a preview request, with its type.
 *
 * TEXT AND NOTHING ELSE. The two documents are readers returning a discriminated
 * text-or-reason result; the only other member is a number. There is no string a
 * surface would interpret as a location.
 */
const PREVIEW_REQUEST_SURFACE = [
  "PreviewRequestV1.controlTransitionAllowance: number",
  "PreviewRequestV1.documents: PreparationStageDocumentsV1",
  "PreviewRequestV1.documents.plan: () => Promise<PreparationDocumentV1>",
  "PreviewRequestV1.documents.plan().ok: false",
  "PreviewRequestV1.documents.plan().ok: true",
  "PreviewRequestV1.documents.plan().reason: string",
  "PreviewRequestV1.documents.plan().text: string",
  "PreviewRequestV1.documents.seed: () => Promise<PreparationDocumentV1>",
  "PreviewRequestV1.documents.seed().ok: false",
  "PreviewRequestV1.documents.seed().ok: true",
  "PreviewRequestV1.documents.seed().reason: string",
  "PreviewRequestV1.documents.seed().text: string",
];

/** The checker and the declared type of the request, from a real program. */
function requestType(): { checker: ts.TypeChecker; type: ts.Type; source: ts.SourceFile } {
  const program = ts.createProgram([SERVICE_STAGE], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(SERVICE_STAGE);
  if (source === undefined) throw new Error("service-stage.ts is not in the program");
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error("service-stage.ts exports nothing");
  const exported = checker.getExportsOfModule(moduleSymbol)
    .find((symbol) => symbol.name === REQUEST_TYPE);
  if (exported === undefined) throw new Error(`${REQUEST_TYPE} is not exported`);
  return { checker, type: checker.getDeclaredTypeOfSymbol(exported), source };
}

/**
 * Whether this type is one THIS PROJECT declares.
 *
 * The walk stops at anything else, which is what keeps it from descending into
 * `number.toExponential().…` and enumerating the standard library instead of the
 * request. A type declared outside `src/` is not a member a caller supplies.
 */
function declaredInSrc(type: ts.Type): boolean {
  const declarations = type.getSymbol()?.declarations ?? type.aliasSymbol?.declarations ?? [];
  return declarations.some((node) => node.getSourceFile().fileName.startsWith(SRC_PREFIX));
}

/** A reader's payload is what it resolves to, so the walk follows through it. */
function unwrapPromise(type: ts.Type): ts.Type {
  const reference = type as ts.TypeReference;
  return type.getSymbol()?.name === "Promise" && reference.typeArguments?.[0] !== undefined
    ? reference.typeArguments[0]
    : type;
}

/** One walk context, so the recursion carries three arguments instead of six. */
interface SurfaceWalk {
  readonly checker: ts.TypeChecker;
  readonly source: ts.SourceFile;
  readonly found: Set<string>;
}

/**
 * Collect every member reachable from `type`, through properties and readers.
 *
 * EVERY UNION ARM SEPARATELY, so a discriminated result contributes the members
 * of both its arms rather than only the ones they share.
 */
function collect(walk: SurfaceWalk, type: ts.Type, prefix: string, depth: number): void {
  if (depth > MAX_DEPTH) return;
  for (const arm of type.isUnion() ? type.types : [type]) {
    if (declaredInSrc(arm)) collectMembers(walk, arm, prefix, depth);
  }
}

/** One object type's readers and its own properties. */
function collectMembers(walk: SurfaceWalk, type: ts.Type, prefix: string, depth: number): void {
  for (const signature of type.getCallSignatures()) {
    collect(walk, unwrapPromise(signature.getReturnType()), `${prefix}()`, depth + 1);
  }
  for (const property of type.getProperties()) {
    collectProperty(walk, property, prefix, depth);
  }
}

/** Record one property with its type, then follow it. */
function collectProperty(
  walk: SurfaceWalk, property: ts.Symbol, prefix: string, depth: number,
): void {
  const at = property.valueDeclaration ?? property.declarations?.[0] ?? walk.source;
  const propertyType = walk.checker.getTypeOfSymbolAtLocation(property, at);
  const label = `${prefix}.${property.name}`;
  walk.found.add(`${label}: ${walk.checker.typeToString(propertyType)}`);
  collect(walk, propertyType, label, depth + 1);
}

describe("a grant-free preview cannot be handed a filesystem path", () => {
  it("exposes exactly the documents-as-text request surface and nothing else", () => {
    const { checker, type, source } = requestType();
    const found = new Set<string>();
    collect({ checker, source, found }, type, REQUEST_TYPE, 0);
    // THE WHOLE SET. A new member fails here whatever it is called, which is the
    // point: the last version of this defect arrived as `sourceRoot`.
    //
    // BOTH SIDES SORTED BY THE SAME COMPARATOR. The expected list is written in
    // reading order and ordered here, because the first version of it was sorted
    // by a shell `sort` whose collation differs from JavaScript's on `(` versus
    // `:` — a red for a reason that had nothing to do with the property.
    expect([...found].sort()).toEqual([...PREVIEW_REQUEST_SURFACE].sort());
  });
});
