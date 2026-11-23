/**
 * @file scripts/public-boundary/dependencies.mjs
 * @description The DEPENDENCY check of the release gate: each public package
 * may declare exactly the reviewed dependency set, and may import nothing
 * outside it.
 *
 * The allowlist is frozen in the manifest per package and per field
 * (`dependencies`, `peerDependencies`, `optionalDependencies`). Every entry
 * must either equal the recorded public baseline (same field, same range) or
 * be an approved addition with a recorded reason; an in-repository package is
 * pinned to the release version. A range must be a plain semver range: an
 * alias, URL, git, file, link, workspace or tag form is refused. This
 * repository's own package manifests are NOT an allowlist and are not read.
 * Usage comes from the public import graph, so nothing is installed or fetched.
 * Type-only imports count only from entries that ship declarations: the core
 * per-module entries are bundled without declarations, so a type-only import
 * there is erased from the JavaScript and appears in no emitted declaration.
 */

import { builtinModules } from "node:module";
import { releaseComposition } from "./composition.mjs";
import { buildGraph, reach } from "./graph.mjs";

/** The dependency fields a public manifest may carry. */
export const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

/** A plain semver range: comparators, carets, tildes, hyphen ranges and `||`, digits and dots only. */
const PLAIN_SEMVER_RANGE = /^(?:[\^~]|>=|<=|>|<|=)?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\s*(?:\|\||-|\s)\s*(?:[\^~]|>=|<=|>|<|=)?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)*$/u;

/** Whether a range is a plain semver range and nothing else. */
export function isPlainSemverRange(range) {
  return typeof range === "string" && PLAIN_SEMVER_RANGE.test(range.trim());
}

/** The npm package a bare specifier belongs to, or `null` for a Node built-in. */
export function packageOf(specifier) {
  if (specifier.startsWith("node:") || builtinModules.includes(specifier.split("/")[0])) return null;
  return specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
}

/** Whether version `a` is strictly greater than `b` (numeric major.minor.patch). */
function isVersionAbove(a, b) {
  const [left, right] = [a, b].map((version) => String(version).split("-")[0].split(".").map(Number));
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return false;
}

/** Findings about one allowlist entry's range and provenance. */
function entryFindings(packageName, field, name, range, context) {
  const { baselinePackage, approved, inRepository, releaseVersion } = context;
  const where = { package: packageName, field, name, range };
  if (inRepository.includes(name)) {
    return range === releaseVersion ? [] : [{ ...where, kind: "in-repository-dependency-not-pinned-to-release-version", expected: releaseVersion }];
  }
  if (!isPlainSemverRange(range)) return [{ ...where, kind: "range-is-not-a-plain-semver-range" }];
  if (baselinePackage?.[field]?.[name] === range) return [];
  const addition = approved.find((entry) => entry.name === name && entry.field === field && entry.range === range);
  return addition === undefined ? [{ ...where, kind: "not-in-baseline-and-not-an-approved-addition", baselineRange: baselinePackage?.[field]?.[name] ?? null }] : [];
}

/**
 * The edge one outside reference records from its module, or null when it
 * records nothing. A runtime use (a non-type reference from a module reached at
 * runtime) is always "runtime"; any other reference is "type-only" only when
 * the entry ships declarations (`withTypes`).
 */
function referenceEdge(reference, isRuntimeModule, withTypes) {
  if (reference.kind !== "type" && isRuntimeModule) return "runtime";
  return withTypes ? "type-only" : null;
}

/**
 * Record the outside packages one reached module imports into `used`. Node
 * built-ins record nothing; a runtime use always records, replacing an earlier
 * type-only use; a type-only use records only when the package has no entry yet.
 */
function recordModuleUses(built, module, runtime, used, withTypes) {
  const isRuntimeModule = runtime.has(module);
  for (const reference of built.externals.get(module) ?? []) {
    const name = packageOf(reference.specifier);
    const edge = name === null ? null : referenceEdge(reference, isRuntimeModule, withTypes);
    if (edge === "runtime" || (edge !== null && !used.has(name))) used.set(name, { edge, from: module });
  }
}

/**
 * Outside packages one public package's own bundle imports (runtime and type edges kept apart). Each entry is
 * `{ file, declared }`; type edges are followed only from entries that ship declarations.
 */
function usedPackages(built, entries) {
  const used = new Map();
  for (const { file, declared } of entries) {
    const runtime = reach(built.graph, file, ["runtime", "dynamic"], true);
    const kinds = declared ? ["runtime", "dynamic", "type"] : ["runtime", "dynamic"];
    for (const module of reach(built.graph, file, kinds, true).keys()) recordModuleUses(built, module, runtime, used, declared);
  }
  return used;
}

/** Findings about every allowlisted entry of one package, field by field, and the names it declares. */
function allowlistFindings(entry, allow, context) {
  const findings = [];
  const declared = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(allow[field] ?? {})) {
      declared.add(name);
      findings.push(...entryFindings(entry.name, field, name, range, context));
    }
  }
  return { findings, declared };
}

/** Imported outside packages the allowlist does not declare (the package itself excepted). */
function undeclaredUseFindings(packageName, declared, used) {
  return [...used].filter(([name]) => !declared.has(name) && name !== packageName)
    .map(([name, use]) => ({ package: packageName, kind: "imported-package-not-in-allowlist", name, ...use }));
}

/** Baseline dependencies the allowlist dropped (in-repository packages are pinned separately). */
function droppedBaselineFindings(packageName, allow, context) {
  return DEPENDENCY_FIELDS.flatMap((field) => Object.keys(context.baselinePackage?.[field] ?? {})
    .filter((name) => allow[field]?.[name] === undefined && !context.inRepository.includes(name))
    .map((name) => ({ package: packageName, field, kind: "baseline-dependency-dropped", name })));
}

/** Findings for one public package: allowlist entries, then undeclared imports, then dropped baseline entries. */
function packageFindings(entry, allow, context, used) {
  const allowed = allowlistFindings(entry, allow, context);
  const findings = [...allowed.findings, ...undeclaredUseFindings(entry.name, allowed.declared, used), ...droppedBaselineFindings(entry.name, allow, context)];
  return { findings, unused: [...allowed.declared].filter((name) => !used.has(name)).sort() };
}

/**
 * Check every public package's frozen dependency allowlist against the public
 * baseline, the approved additions and what its bundle actually imports. The core
 * package's bundle includes its per-module entries (`./composition.mjs`).
 */
export function checkDependencies(root, manifest, baseline) {
  const composition = releaseComposition(root, manifest);
  const built = buildGraph(root, composition.entries, composition.graphConfig);
  const policy = manifest.publicDependencies;
  // The per-module entries are built without declarations (see ../build-public-release.mjs).
  const undeclaredEntries = new Set(composition.moduleNames.map((name) => `core:modules/${name}`));
  const packages = composition.packages.map((entry) => {
    const allow = policy.packages[entry.name] ?? {};
    const context = { baselinePackage: baseline.packages[entry.name], approved: (policy.approvedAdditions ?? []).filter((item) => item.package === entry.name),
      inRepository: manifest.publicRelease.inRepositoryPackages, releaseVersion: policy.releaseVersion };
    const entries = entry.entries.map((key) => ({ file: composition.entries[key], declared: !undeclaredEntries.has(key) }));
    const result = packageFindings(entry, allow, context, usedPackages(built, entries));
    const unused = result.unused.filter((name) => !context.inRepository.includes(name));
    return { name: entry.name, declaredButNotImported: unused, findings: result.findings };
  });
  const findings = packages.flatMap((entry) => entry.findings);
  // A release at or below the published baseline version would be a regression or a republish, never a successor.
  if (!isVersionAbove(policy.releaseVersion, policy.baselineVersion)) {
    findings.push({ kind: "release-version-not-above-public-baseline", releaseVersion: policy.releaseVersion, baselineVersion: policy.baselineVersion });
  }
  return { packages, findings, passed: findings.length === 0 };
}
