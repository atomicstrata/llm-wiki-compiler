/**
 * @file scripts/public-boundary/artifact.mjs
 * @description The ARTIFACT check of the release gate: the STAGED public
 * release, bound to the current source and read byte for byte.
 *
 * Three questions, in order. Is there a stage, and was it built from exactly
 * this source? Every source module each package's entries reach is re-hashed
 * and compared with the release identity the build recorded, and so are every
 * staged file, every release document against its declared source (this tree's
 * reviewed file or the public baseline's) and every recorded build input (build, copy and gate code,
 * boundary data, compiler config, lockfile, viewer asset sources), so a stale
 * or hand-edited stage fails. Installed packages are bound only through the
 * lockfile. Does each staged
 * manifest equal the approved one: the baseline's exports and bin maps, the
 * frozen dependency allowlist, no private flag and no lifecycle script? And
 * what is in the tarball? `npm pack` really packs each staged package
 * (offline, scripts ignored); the archive is extracted and every file read:
 * no internal symbol, no source map naming a module outside the allocated
 * set, and no file the identity does not list. A dry-run file list is never
 * taken as proof. Each package's result names the exact tarball it checked
 * (path, SHA-256 taken before extraction, npm integrity), so a release can
 * carry those very bytes onward (scripts/public-boundary/release-receipt.mjs)
 * instead of packing again.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { buildInputHashes, filesUnder, releaseDocumentSources, sha256Of } from "../build-public-release.mjs";
import { releaseComposition } from "./composition.mjs";
import { DEPENDENCY_FIELDS } from "./dependencies.mjs";
import { buildGraph, reach } from "./graph.mjs";

const SCANNED = /\.(?:js|mjs|cjs|d\.ts|map)$/u;
const ALL_EDGE_KINDS = ["runtime", "dynamic", "type"];
const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepublish"];

/** Whether a repository-relative module path is internal test support. */
function isInternalModule(internal, module) {
  return internal.prefixes.some((prefix) => module.startsWith(prefix)) || internal.modules.includes(module);
}

/** Why a module may not ship (named by a source map, or reached by the gate's graph check), or `null`. */
export function refusedModuleKind(manifest, module) {
  if (isInternalModule(manifest.internal, module)) return "internal-test-support";
  if (!manifest.internalProducts.prefixes.some((prefix) => module.startsWith(prefix))) return null;
  return manifest.internalProducts.coreEmbedded.modules[module] === undefined ? "internal-product" : manifest.internalProducts.coreEmbedded.allocation;
}

/** A source map `sources` entry as a repository-relative path. */
function repositoryPath(source) {
  return source.replace(/^(?:\.\.\/)+/u, "").replace(/^\.\//u, "");
}

/** Findings in one source map: every refused module it names, grouped by kind. */
function mapFindings(manifest, file, text) {
  const map = JSON.parse(text);
  const byKind = new Map();
  for (const source of (map.sources ?? []).map(repositoryPath)) {
    const kind = refusedModuleKind(manifest, source);
    if (kind !== null) byKind.set(kind, [...(byKind.get(kind) ?? []), source]);
  }
  return [...byKind].map(([kind, modules]) => ({ file, kind: `source-map-names-${kind}-module`, modules: modules.sort(), embedsContent: Array.isArray(map.sourcesContent) }));
}

/** Findings in one shipped file: forbidden symbols, and refused modules a source map names or embeds. */
export function scanShippedFile(manifest, file, text) {
  const symbols = manifest.internal.forbiddenSymbols.filter((symbol) => text.includes(symbol));
  const findings = symbols.length === 0 ? [] : [{ file, kind: "forbidden-symbol", symbols }];
  return file.endsWith(".map") ? [...findings, ...mapFindings(manifest, file, text)] : findings;
}

/** Findings where two JSON-serialisable values differ. */
function mustEqual(kind, file, actual, expected) {
  return JSON.stringify(actual ?? null) === JSON.stringify(expected ?? null) ? [] : [{ file, kind, actual: actual ?? null, expected: expected ?? null }];
}

/** Findings where the staged manifest's exports, bin, files or version differ from the approved values. */
function approvedFieldFindings(manifest, baselinePackage, packageJson) {
  return [
    ...mustEqual("exports-map-differs-from-approved", "package.json", packageJson.exports, baselinePackage.exports),
    ...mustEqual("bin-map-differs-from-approved", "package.json", packageJson.bin, baselinePackage.bin),
    ...mustEqual("files-list-differs-from-approved", "package.json", packageJson.files, baselinePackage.files),
    ...mustEqual("version-differs-from-release-version", "package.json", packageJson.version, manifest.publicDependencies.releaseVersion),
  ];
}

/** Findings where a dependency field differs from the frozen allowlist (an empty allowlist field means the field must be absent). */
function dependencyFindings(allow, packageJson) {
  return DEPENDENCY_FIELDS.flatMap((field) => {
    const expected = allow[field] !== undefined && Object.keys(allow[field]).length > 0 ? allow[field] : undefined;
    return mustEqual(`${field}-differ-from-allowlist`, "package.json", packageJson[field], expected);
  });
}

/** Findings for fields a published package must not carry: private, lifecycle scripts, development fields. */
function publicationFieldFindings(packageJson) {
  const findings = [];
  if (packageJson.private === true) findings.push({ file: "package.json", kind: "public-package-is-private" });
  const scripts = Object.keys(packageJson.scripts ?? {}).filter((name) => LIFECYCLE_SCRIPTS.includes(name));
  if (scripts.length > 0) findings.push({ file: "package.json", kind: "lifecycle-script-present", scripts });
  if (packageJson.devDependencies !== undefined || packageJson.workspaces !== undefined) findings.push({ file: "package.json", kind: "development-field-present" });
  return findings;
}

/** Findings in a staged public manifest against the baseline maps and the frozen dependency allowlist, in that order. */
export function manifestFindings(manifest, baselinePackage, packageJson) {
  const allow = manifest.publicDependencies.packages[packageJson.name] ?? {};
  return [...approvedFieldFindings(manifest, baselinePackage, packageJson), ...dependencyFindings(allow, packageJson), ...publicationFieldFindings(packageJson)];
}

/** Findings where a recorded `path → sha256` map no longer matches what is on disk under `base`. */
export function hashFindings(kind, recorded, current) {
  const findings = [];
  for (const [file, hash] of Object.entries(recorded)) {
    if (current[file] === undefined) findings.push({ kind: `${kind}-missing`, file });
    else if (current[file] !== hash) findings.push({ kind: `${kind}-changed`, file });
  }
  for (const file of Object.keys(current)) if (recorded[file] === undefined) findings.push({ kind: `${kind}-not-in-identity`, file });
  return findings;
}

/** The current `module → sha256` of every source module a package's entries (core per-module entries included) reach. */
function currentSources(root, built, entry) {
  const modules = new Set();
  for (const key of entry.entries) for (const module of reach(built.graph, built.entries[key], ALL_EDGE_KINDS, true).keys()) modules.add(module);
  return Object.fromEntries([...modules].sort().map((module) => [module, sha256Of(path.join(root, module))]));
}

/** Really pack one staged package; return the directory its tarball extracts to and that tarball's record (repository-relative path, SHA-256, npm integrity). */
function packAndExtract(root, packageDir, workDir) {
  mkdirSync(workDir, { recursive: true });
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", workDir], {
    cwd: packageDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  });
  const [report] = JSON.parse(output);
  const file = path.join(workDir, report.filename);
  const tarball = { file: path.relative(root, file), sha256: sha256Of(file), integrity: report.integrity };
  execFileSync("tar", ["-xzf", file, "-C", workDir]);
  return { extracted: path.join(workDir, "package"), tarball };
}

/** A `files` negation that names one exact path, such as `!dist/tsconfig.json`. A glob is not one. */
const EXACT_NEGATION = /^![^*?[\]{}!]+$/u;

/**
 * Findings for staged files the tarball does not carry. Every file the
 * package identity records is expected in its tarball, except an exact path
 * the tarball's own manifest negates in `files` (the only omission a reviewed
 * manifest can declare; `!dist/tsconfig.json` today, which the stage never
 * writes). A negation with a glob cannot be accounted for file by file, so it
 * is a finding itself. Without this, a payload file npm leaves out passed.
 *
 * @param identityFiles - The package identity's `path → sha256` map (the stage as built).
 * @param tarballFiles - Every file path in the extracted tarball.
 * @param packageJson - The tarball's own package.json.
 */
export function tarballCompletenessFindings(identityFiles, tarballFiles, packageJson) {
  const negations = (packageJson.files ?? []).filter((entry) => entry.startsWith("!"));
  const omitted = new Set(negations.filter((entry) => EXACT_NEGATION.test(entry)).map((entry) => entry.slice(1).replace(/^\.\//u, "")));
  const findings = negations.filter((entry) => !EXACT_NEGATION.test(entry)).map((entry) => ({ kind: "files-negation-not-an-exact-path", entry }));
  const present = new Set(tarballFiles);
  for (const file of Object.keys(identityFiles).sort()) {
    if (!present.has(file) && !omitted.has(file)) findings.push({ kind: "identity-file-missing-from-tarball", file });
  }
  return findings;
}

/** Findings in the extracted tarball of one package: its file set (extra, changed and missing files), its manifest, and every scanned byte. */
function tarballFindings(manifest, baselinePackage, identity, extracted) {
  const files = filesUnder(extracted);
  const findings = files.filter((file) => identity.files[file] === undefined).map((file) => ({ kind: "tarball-file-not-in-identity", file }));
  for (const file of files.filter((candidate) => identity.files[candidate] !== undefined && identity.files[candidate] !== sha256Of(path.join(extracted, candidate)))) {
    findings.push({ kind: "tarball-file-differs-from-stage", file });
  }
  const packageJson = JSON.parse(readFileSync(path.join(extracted, "package.json"), "utf8"));
  findings.push(...tarballCompletenessFindings(identity.files, files, packageJson));
  findings.push(...manifestFindings(manifest, baselinePackage, packageJson));
  for (const file of files.filter((candidate) => SCANNED.test(candidate))) findings.push(...scanShippedFile(manifest, file, readFileSync(path.join(extracted, file), "utf8")));
  for (const asset of manifest.artifact.bundledThirdPartyAssets) {
    const count = files.filter((file) => file.startsWith(asset.prefix)).length;
    if (count > 0 && asset.allocation !== "approved") findings.push({ kind: `bundled-third-party-asset-${asset.allocation}`, package: asset.package, files: count });
  }
  return { files: files.length, findings };
}

/** Check one staged package against the identity, the current source and its real tarball. */
function packageFindings(root, manifest, baseline, built, entry, identity, workDir) {
  const packageDir = path.join(root, manifest.publicRelease.stageDir, entry.stage);
  const staged = Object.fromEntries(filesUnder(packageDir).map((file) => [file, sha256Of(path.join(packageDir, file))]));
  const findings = [
    ...hashFindings("source", identity.sources, currentSources(root, built, entry)),
    ...hashFindings("staged-file", identity.files, staged),
  ];
  const packed = packAndExtract(root, packageDir, path.join(workDir, entry.stage));
  const tarball = tarballFindings(manifest, baseline.packages[entry.name], identity, packed.extracted);
  return { name: entry.name, sources: Object.keys(identity.sources).length, tarballFiles: tarball.files, tarball: packed.tarball, findings: [...findings, ...tarball.findings.map((finding) => ({ package: entry.name, ...finding }))] };
}

/** The `path → sha256` of a recorded or current release-document set. */
function documentHashes(documents) {
  return Object.fromEntries(Object.entries(documents).map(([file, entry]) => [file, `${entry.from}:${entry.sha256}`]));
}

/**
 * Findings where the release documents no longer match their declared
 * sources: a source document edited, added, removed or re-declared since the
 * stage was built, or a staged copy that is not its source's bytes.
 */
export function documentFindings(root, manifest, baseline, identity) {
  const current = releaseDocumentSources(root, manifest, baseline.commit);
  const findings = hashFindings("release-document", documentHashes(identity.documents ?? {}), documentHashes(current));
  const rootStage = path.join(root, manifest.publicRelease.stageDir, manifest.publicPackages.find((entry) => entry.dir === ".").stage);
  for (const [file, entry] of Object.entries(current)) {
    const staged = path.join(rootStage, file);
    if (!existsSync(staged) || sha256Of(staged) !== entry.sha256) findings.push({ kind: "staged-release-document-differs-from-source", file, from: entry.from });
  }
  return findings;
}

/**
 * Check the staged public release.
 *
 * @returns `unstaged: true` (a failure) when no stage or identity exists: an
 *   artifact that was not built from this source was not approved.
 */
export function checkArtifact(root, manifest, baseline) {
  const stage = path.join(root, manifest.publicRelease.stageDir);
  const identityFile = path.join(stage, "release-identity.json");
  if (!existsSync(identityFile)) return { unstaged: true, packages: [], findings: [{ kind: "no-staged-release" }], passed: false };
  const identity = JSON.parse(readFileSync(identityFile, "utf8"));
  const composition = releaseComposition(root, manifest);
  // The graph carries the composition's entry map, so each package's current sources are read from the same entries the stage was built from.
  const built = { ...buildGraph(root, composition.entries, composition.graphConfig), entries: composition.entries };
  const workDir = path.join(root, path.dirname(manifest.publicRelease.stageDir), "pack-check");
  rmSync(workDir, { recursive: true, force: true });
  const manifestSha = sha256Of(path.join(root, "scripts/public-boundary/manifest.json"));
  const findings = identity.manifestSha256 === manifestSha ? [] : [{ kind: "boundary-manifest-changed-since-build" }];
  if (identity.publicBaselineCommit !== baseline.commit) findings.push({ kind: "public-baseline-changed-since-build" });
  findings.push(...hashFindings("build-input", identity.buildInputs ?? {}, buildInputHashes(root)));
  findings.push(...documentFindings(root, manifest, baseline, identity));
  const packages = composition.packages.map((entry) => {
    const recorded = identity.packages.find((candidate) => candidate.name === entry.name);
    if (recorded === undefined) return { name: entry.name, findings: [{ package: entry.name, kind: "package-not-in-identity" }] };
    return packageFindings(root, manifest, baseline, built, entry, recorded, workDir);
  });
  findings.push(...packages.flatMap((entry) => entry.findings.map((finding) => ({ package: entry.name, ...finding }))));
  return { unstaged: false, builtAt: identity.builtAt, packages: packages.map(({ findings: _dropped, ...rest }) => rest), findings, passed: findings.length === 0 };
}
