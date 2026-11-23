#!/usr/bin/env node
/**
 * @file scripts/check-public-boundary.mjs
 * @description The public release gate. It refuses a public release
 * composition, dependency set or staged artifact that would publish internal
 * test support, an internal product feature or an unallocated surface.
 *
 *   node scripts/check-public-boundary.mjs               every check AND the release readiness (the default)
 *   … --graph         the public entries reach no internal test-support or internal product module
 *   … --surface       public facades, CLI commands and MCP tools are baseline or allocated, and none is dropped
 *   … --dependencies  each public package's dependencies are exactly the reviewed allowlist
 *   … --artifact      the STAGED release was built from this exact source, and its tarball bytes are clean
 *   … --shapes        the public declarations stay assignable to the public baseline's
 *   … --write-baseline <git-ref>      record the public baseline from a public source ref
 *   … --write-public-facades          regenerate the checked-in public facades from the manifest
 *   --json                            print the full report as JSON
 *
 * The checks answer different questions and none stands in for another. There
 * is no environment variable or flag that skips a check in the default run.
 *
 * MECHANISMS ARE NOT ACCEPTANCE. Each check is a mechanism: it measures one
 * thing about this source and its staged artifact. The default run also
 * reports RELEASE READINESS, apart from them: ready only when every mechanism
 * passes AND the manifest's `openReleaseItems` list is empty. That list holds
 * the prerequisites and decisions no mechanism measures, so the default run
 * exits non-zero while one is open even if every mechanism passes. A run that
 * names checks reports those mechanisms only; its exit status is theirs.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkArtifact, refusedModuleKind } from "./public-boundary/artifact.mjs";
import { releaseComposition } from "./public-boundary/composition.mjs";
import { checkDependencies } from "./public-boundary/dependencies.mjs";
import { derivePublicFacade, originsOf } from "./public-boundary/facades.mjs";
import { buildGraph, chainTo, reach } from "./public-boundary/graph.mjs";
import { checkShapes } from "./public-boundary/shapes.mjs";
import { baselineOf, checkSurface } from "./public-boundary/surface.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOUNDARY_DIR = path.join(ROOT, "scripts", "public-boundary");
const ALL_EDGE_KINDS = ["runtime", "dynamic", "type"];
const RUNTIME_EDGE_KINDS = ["runtime", "dynamic"];
const CHECKS = ["graph", "surface", "dependencies", "artifact", "shapes"];

/** Read one JSON file of the boundary directory. */
function readBoundaryJson(name) {
  return JSON.parse(readFileSync(path.join(BOUNDARY_DIR, name), "utf8"));
}

/** The public composition's graph (the release entries plus the core per-module entries), built once per run. */
function publicGraph(composition) {
  return buildGraph(ROOT, composition.entries, composition.graphConfig);
}

/** How a refused module is reached: at runtime, or only through type edges. */
function edgeOf(runtime, module) {
  return runtime.has(module) ? "runtime" : "type-only";
}

/**
 * What one public entry reaches that the boundary refuses, in sorted module
 * order: violation records (with one import chain each), and the reached
 * modules allocated to the embedded core product, which stay pending.
 */
function entryReach(manifest, composition, built, entry) {
  const module = composition.entries[entry];
  const parent = reach(built.graph, module, ALL_EDGE_KINDS);
  const runtime = reach(built.graph, module, RUNTIME_EDGE_KINDS);
  const found = { violations: [], pending: [] };
  for (const reached of [...parent.keys()].sort()) {
    const kind = refusedModuleKind(manifest, reached);
    if (kind === null) continue;
    if (kind === manifest.internalProducts.coreEmbedded.allocation) found.pending.push(reached);
    else found.violations.push({ entry, module: reached, kind, edge: edgeOf(runtime, reached), chain: chainTo(parent, reached) });
  }
  return found;
}

/** Every module a public entry (core per-module entries included) reaches that the boundary refuses, with one import chain each. */
function checkGraph(manifest, composition, built) {
  const found = Object.keys(composition.entries).map((entry) => entryReach(manifest, composition, built, entry));
  const pending = new Set(found.flatMap((item) => item.pending));
  const stale = Object.keys(manifest.internalProducts.coreEmbedded.modules).filter((module) => !pending.has(module)).sort();
  return { modules: built.graph.size, entries: Object.keys(composition.entries).length, problems: built.problems,
    violations: found.flatMap((item) => item.violations), pendingCoreEmbedded: [...pending].sort(), staleCoreEmbedded: stale };
}

/** Record the baseline of a public source ref, read with `git show` only. */
function writeBaseline(ref) {
  const manifest = readBoundaryJson("manifest.json");
  const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const commit = git("rev-parse", `${ref}^{commit}`).trim();
  const readFile = (file) => git("show", `${commit}:${file}`);
  const listDir = (dir) => git("ls-tree", "-r", "--name-only", commit, dir).split("\n").filter((file) => file.endsWith(".ts"));
  const packages = Object.fromEntries(manifest.publicPackages.map((entry) => [entry.name, JSON.parse(readFile(path.posix.join(entry.dir, "package.json")))]));
  const baseline = { ref, commit, note: "Generated by check-public-boundary.mjs --write-baseline; do not edit by hand.",
    ...baselineOf(readFile, listDir, manifest.surface.facades), packages };
  writeFileSync(path.join(BOUNDARY_DIR, "baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}

/** Regenerate the checked-in public facades from the manifest and baseline. */
function writePublicFacades() {
  const manifest = readBoundaryJson("manifest.json");
  const baseline = readBoundaryJson("baseline.json");
  const coreOrigins = originsOf(ROOT, manifest.surface.facades.core.internal);
  // A tree whose facades are their own source has nothing to derive: writing would replace hand-kept source.
  const ownSource = Object.values(manifest.surface.facades).filter((facade) => facade.internal === facade.public).map((facade) => facade.public);
  if (ownSource.length > 0) throw new Error(`refusing to derive facades that are their own source: ${ownSource.join(", ")}`);
  return Object.entries(manifest.surface.facades).map(([key, facade]) => {
    mkdirSync(path.dirname(path.join(ROOT, facade.public)), { recursive: true });
    writeFileSync(path.join(ROOT, facade.public), derivePublicFacade(ROOT, manifest.surface, baseline, key, key === "root" ? coreOrigins : null));
    return facade.public;
  });
}

/** Whether the graph check passed: nothing unfollowable, refused, pending or stale. */
function graphPassed(result) {
  return result.problems.length === 0 && result.violations.length === 0 && result.pendingCoreEmbedded.length === 0 && result.staleCoreEmbedded.length === 0;
}

/** Whether the surface check passed: no violation and no baseline name missing anywhere. */
function surfacePassed(result) {
  return result.violations.length === 0 && Object.values(result.missingBaseline).flat().length === 0;
}

/** Record whether one check's result passed, as its last field, and return it. */
function withPassed(result, passed) {
  result.passed = passed(result);
  return result;
}

/** The surface check over the modules the public CLI entry reaches at runtime. */
function surfaceReport({ manifest, baseline, built }) {
  const cliEntry = manifest.publicRelease.entries["root:cli"];
  return checkSurface(ROOT, manifest, baseline, [...reach(built.graph, cliEntry, RUNTIME_EDGE_KINDS).keys()], built.graph);
}

/** Each check's runner over one run's shared inputs (the manifest, the baseline and the public graph). */
const CHECK_RUNNERS = {
  graph: (inputs) => withPassed(checkGraph(inputs.manifest, inputs.composition, inputs.built), graphPassed),
  surface: (inputs) => withPassed(surfaceReport(inputs), surfacePassed),
  dependencies: (inputs) => checkDependencies(ROOT, inputs.manifest, inputs.baseline),
  artifact: (inputs) => checkArtifact(ROOT, inputs.manifest, inputs.baseline),
  shapes: (inputs) => checkShapes(ROOT, inputs.manifest, inputs.baseline),
};

/** Run the selected checks, in `CHECKS` order, and say whether each passed. */
function runChecks(selected) {
  const manifest = readBoundaryJson("manifest.json");
  const composition = releaseComposition(ROOT, manifest);
  const inputs = { manifest, composition, baseline: readBoundaryJson("baseline.json"), built: publicGraph(composition) };
  const report = {};
  for (const check of CHECKS.filter((name) => selected.includes(name))) report[check] = CHECK_RUNNERS[check](inputs);
  return report;
}

/**
 * Release readiness: every mechanism passed AND no release item is open. Kept
 * apart from the mechanism results so a green mechanism is never read as a
 * release decision.
 */
function readinessOf(manifest, report) {
  const openItems = (manifest.openReleaseItems?.items ?? []).map((item) => ({ id: item.id, category: item.category ?? "uncategorised", check: item.check ?? null, needs: item.needs }));
  const mechanismsPassed = Object.values(report).every((result) => result.passed);
  return { mechanismsPassed, openItems, passed: mechanismsPassed && openItems.length === 0 };
}

/** The report key of the release-readiness answer, which the default run adds after the mechanisms. */
const READINESS = "releaseReadiness";
/** How many problems of one failed check the human summary prints before pointing to `--json`. */
const SHOWN_PROBLEMS = 12;

/** The printable problem records of each check that has its own problem shape; the rest print `findings`. */
const PROBLEM_RECORDS = new Map([
  [READINESS, (result) => result.openItems.map((item) => ({ openReleaseItem: item.id, category: item.category, needs: item.needs }))],
  ["graph", (result) => [...result.problems, ...result.violations, ...result.pendingCoreEmbedded.map((module) => ({ pendingCoreEmbedded: module })),
    ...result.staleCoreEmbedded.map((module) => ({ staleCoreEmbedded: module }))]],
  ["surface", (result) => [...result.violations, ...Object.entries(result.missingBaseline).filter(([, names]) => names.length > 0)
    .map(([where, names]) => ({ missingBaseline: where, names }))]],
]);

/** The first problems of one failed check, as printable records. */
function problemsOf(name, result) {
  const records = PROBLEM_RECORDS.get(name);
  return records === undefined ? result.findings ?? [] : records(result);
}

/** The status word of one summary line: READY/NOT READY for readiness, PASS/FAIL for a mechanism. */
function statusWord(name, passed) {
  const [failed, succeeded] = name === READINESS ? ["NOT READY", "READY"] : ["FAIL", "PASS"];
  return passed ? succeeded : failed;
}

/** The label of one summary line: the check's name, or the readiness description. */
function summaryLabel(name, result) {
  if (name !== READINESS) return name;
  return `release readiness (${result.openItems.length} open item(s); mechanisms ${result.mechanismsPassed ? "pass" : "fail"})`;
}

/** Print the first {@link SHOWN_PROBLEMS} problems, then how many more `--json` would show. */
function printProblems(problems) {
  for (const problem of problems.slice(0, SHOWN_PROBLEMS)) console.log(`      ${JSON.stringify(problem)}`);
  if (problems.length > SHOWN_PROBLEMS) console.log(`      … ${problems.length - SHOWN_PROBLEMS} more (use --json)`);
}

/** One human-readable line per check, then the first few problems of each failure. */
function printSummary(report) {
  for (const [name, result] of Object.entries(report)) {
    console.log(`${statusWord(name, result.passed)}  ${summaryLabel(name, result)}`);
    if (!result.passed) printProblems(problemsOf(name, result));
  }
}

/** Write the public baseline from `ref` and print its one-line summary. */
function runWriteBaseline(ref) {
  const baseline = writeBaseline(ref);
  console.log(`baseline ${baseline.commit}: ${Object.entries(baseline.exports).map(([key, names]) => `${names.length} ${key}`).join(", ")} exports, ${baseline.cliCommands.length} CLI commands, ${baseline.mcpTools.length} MCP tools`);
  return 0;
}

/** Regenerate the public facades and print each file written. */
function runWritePublicFacades() {
  for (const file of writePublicFacades()) console.log(`wrote ${file}`);
  return 0;
}

/** Print the report as JSON or as the human summary. */
function printReport(report, asJson) {
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else printSummary(report);
}

/** The exit status of a report: 0 only when every entry, readiness included, passed. */
function exitStatusOf(report) {
  return Object.values(report).every((result) => result.passed) ? 0 : 1;
}

/** Run the named checks (every check, plus release readiness, when none is named), print, and return the exit status. */
function runReport(argv) {
  const selected = CHECKS.filter((check) => argv.includes(`--${check}`));
  const report = runChecks(selected.length === 0 ? CHECKS : selected);
  // The default run also answers the release question, apart from the mechanisms.
  if (selected.length === 0) report[READINESS] = readinessOf(readBoundaryJson("manifest.json"), report);
  printReport(report, argv.includes("--json"));
  return exitStatusOf(report);
}

/** Parse arguments, run, print and exit. */
function main(argv) {
  const baselineAt = argv.indexOf("--write-baseline");
  if (baselineAt !== -1) return runWriteBaseline(argv[baselineAt + 1]);
  if (argv.includes("--write-public-facades")) return runWritePublicFacades();
  return runReport(argv);
}

process.exitCode = main(process.argv.slice(2));
