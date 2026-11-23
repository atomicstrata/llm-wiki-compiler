#!/usr/bin/env node
/**
 * @file scripts/build-public-release.mjs
 * @description Stage the PUBLIC release of llm-wiki-compiler and its two
 * public packages, from the public release composition only.
 *
 *   node scripts/build-public-release.mjs
 *
 * It builds the manifest's release entries, plus the core package's per-module
 * entries (`scripts/public-boundary/composition.mjs`), into
 * `.public-release/stage/<package>/dist`, writes each package's manifest from
 * the PUBLIC BASELINE manifest plus the frozen dependency allowlist (never
 * from this repository's own package.json files), copies the baseline's
 * shipped documents, and records a release identity: for every package, the
 * SHA-256 of each source module its entries reach and of each staged file,
 * plus the build, copy and gate code, the boundary data, the compiler config,
 * the lockfile and every viewer asset source. It does not hash installed
 * packages: the lockfile stands for them.
 *
 * HEAD is read once. That full commit SHA is the identity's `head` and every
 * staged package.json's `gitHead`, so a published package names the commit
 * its release identity was built at. It does not prove the working tree was
 * clean at that commit; a release stages from a clean checkout of public_sha.
 *
 * It refuses to finish when a bundle contains a module the import graph did
 * not predict. It does not publish, and it is not a gate: run
 * `node scripts/check-public-boundary.mjs` afterwards, which verifies that the
 * stage was built from exactly the current source and reads the tarball bytes.
 * Nothing is fetched or installed.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEPENDENCY_FIELDS } from "./public-boundary/dependencies.mjs";
import { releaseComposition } from "./public-boundary/composition.mjs";
import { buildGraph, reach } from "./public-boundary/graph.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOUNDARY_DIR = path.join(ROOT, "scripts", "public-boundary");
const METAFILE = "metafile-esm.json";
const ALL_EDGE_KINDS = ["runtime", "dynamic", "type"];
const CORE_SPECIFIERS = ["@atomicstrata/llmwiki-core", "@atomicstrata/llmwiki-core/*", "@atomicstrata/llmwiki-local-workflows"];
/** Manifest fields that never belong in a published package. */
const DROPPED_MANIFEST_FIELDS = ["scripts", "devDependencies", "workspaces", "private"];
/** A full commit SHA: the only head a release identity and a staged `gitHead` may record. */
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/u;

/** SHA-256 of a file's bytes, as hex (shared with the release gate's artifact check). */
export function sha256Of(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Every file under `dir`, as paths relative to it. */
export function filesUnder(dir, prefix = "") {
  return readdirSync(path.join(dir, prefix)).sort().flatMap((name) => {
    const relative = prefix === "" ? name : `${prefix}/${name}`;
    return statSync(path.join(dir, relative)).isDirectory() ? filesUnder(dir, relative) : [relative];
  });
}

/** Options every staged bundle shares; `config: false` keeps repository tsup configs out of it. */
function sharedOptions(outDir) {
  return { config: false, format: ["esm"], target: "node24", sourcemap: true, metafile: true, clean: false, silent: true,
    outDir, tsconfig: path.join(ROOT, "tsconfig.json") };
}

/**
 * Run one bundle and return the repository source inputs esbuild put in it; the metafile never stays in the package.
 * tsup is imported here, on first use, so a module that only needs this file's data (the gate's build-input list,
 * the baseline writer) never loads tsup, esbuild or rollup.
 */
async function bundle(options) {
  const { build } = await import("tsup");
  await build(options);
  const metafile = path.join(options.outDir, METAFILE);
  // esbuild names an import that carries attributes `<path> with { … }`; the module is the path.
  const inputs = [...new Set(Object.keys(JSON.parse(readFileSync(metafile, "utf8")).inputs).map((input) => input.replace(/ with \{[^}]*\}$/u, "")))]
    .filter((input) => !input.includes("node_modules/"));
  rmSync(metafile);
  return inputs;
}

/**
 * Build the three public packages into the stage, in dependency order; returns each package's bundled inputs.
 * The core package builds its six typed entries AND every per-module entry together, so they share one set of
 * chunks (one module identity per installation); declarations cover the six typed entries only, as in the
 * ordinary core build.
 */
async function buildPackages(composition, stage) {
  const entry = (key) => path.join(ROOT, composition.entries[key]);
  const dtsRoot = { compilerOptions: { rootDir: path.join(ROOT, "src") } };
  const typed = { index: entry("core:index"), "compiler-cli": entry("core:compiler-cli"), "compiler-legacy-workflows": entry("core:compiler-legacy-workflows"),
    "compiler-sdk": entry("core:compiler-sdk"), "local-workflow-host": entry("core:local-workflow-host"), "local-workflow-contracts": entry("core:local-workflow-contracts") };
  const modules = Object.fromEntries(composition.moduleNames.map((name) => [`modules/${name}`, entry(`core:modules/${name}`)]));
  const core = await bundle({ ...sharedOptions(path.join(stage, "llmwiki-core", "dist")), splitting: true, dts: { ...dtsRoot, entry: typed },
    entry: { ...typed, ...modules } });
  const workflows = await bundle({ ...sharedOptions(path.join(stage, "llmwiki-local-workflows", "dist")), splitting: false, dts: dtsRoot,
    entry: { index: entry("local-workflows:index") }, external: ["@atomicstrata/llmwiki-core", "@atomicstrata/llmwiki-core/local-workflow-contracts"] });
  const rootDist = path.join(stage, "llm-wiki-compiler", "dist");
  const cli = await bundle({ ...sharedOptions(rootDist), splitting: false, entry: { cli: entry("root:cli") }, external: CORE_SPECIFIERS, banner: { js: "#!/usr/bin/env node" } });
  const sdk = await bundle({ ...sharedOptions(rootDist), splitting: false, entry: { index: entry("root:sdk") }, external: CORE_SPECIFIERS, dts: true });
  return { "@atomicstrata/llmwiki-core": core, "@atomicstrata/llmwiki-local-workflows": workflows, "llm-wiki-compiler": [...cli, ...sdk] };
}

/** The full commit SHA of HEAD, read once per stage for the release identity and every staged `gitHead`. */
function currentHead() {
  const head = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!FULL_COMMIT_SHA.test(head)) throw new Error(`HEAD is not a full commit SHA: ${head}`);
  return head;
}

/**
 * The staged manifest of one public package: the public baseline's, re-versioned, with the frozen dependency
 * allowlist and `gitHead` set to the commit the release identity records as its `head`.
 */
function stagedManifest(manifest, baseline, name, head) {
  const staged = { ...baseline.packages[name], version: manifest.publicDependencies.releaseVersion, gitHead: head };
  for (const field of [...DROPPED_MANIFEST_FIELDS, ...DEPENDENCY_FIELDS]) delete staged[field];
  for (const field of DEPENDENCY_FIELDS) {
    const allowed = manifest.publicDependencies.packages[name]?.[field];
    if (allowed !== undefined && Object.keys(allowed).length > 0) staged[field] = allowed;
  }
  return staged;
}

/** One declared document path of a provenance, expanded to its files with each file's SHA-256. */
function documentFilesOf(root, from, entry, commit) {
  if (from === "working-tree") {
    const absolute = path.join(root, entry);
    const files = statSync(absolute).isDirectory() ? filesUnder(absolute).map((file) => `${entry}/${file}`) : [entry];
    return files.map((file) => [file, { from, sha256: sha256Of(path.join(root, file)) }]);
  }
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { maxBuffer: 256 * 1024 * 1024 });
  const files = git("ls-tree", "-r", "--name-only", commit, entry).toString("utf8").split("\n").filter((file) => file !== "");
  if (files.length === 0) throw new Error(`release document ${entry} is not in the public baseline ${commit}`);
  return files.map((file) => [file, { from, sha256: createHash("sha256").update(git("show", `${commit}:${file}`)).digest("hex") }]);
}

/**
 * The documents the root package ships, each with its DECLARED provenance and
 * the hash of its source: `working-tree` (this tree's reviewed file) or
 * `baseline` (the recorded public baseline commit's). The manifest's
 * `artifact.releaseDocuments` is the allowlist; nothing else is staged, and a
 * tree never stages a document its manifest does not name.
 */
export function releaseDocumentSources(root, manifest, commit) {
  const declared = manifest.artifact.releaseDocuments;
  const entries = [...declared.fromWorkingTree.map((entry) => ["working-tree", entry]), ...declared.fromBaseline.map((entry) => ["baseline", entry])];
  const files = entries.flatMap(([from, entry]) => documentFilesOf(root, from, entry, commit));
  const sources = Object.fromEntries(files);
  if (Object.keys(sources).length !== files.length) throw new Error("a release document is declared under two provenances");
  return sources;
}

/** Stage every declared release document from its declared source. */
function stageReleaseDocuments(sources, commit, rootPackageDir) {
  for (const [file, { from }] of Object.entries(sources)) {
    const bytes = from === "working-tree" ? readFileSync(path.join(ROOT, file)) : execFileSync("git", ["-C", ROOT, "show", `${commit}:${file}`], { maxBuffer: 256 * 1024 * 1024 });
    mkdirSync(path.dirname(path.join(rootPackageDir, file)), { recursive: true });
    writeFileSync(path.join(rootPackageDir, file), bytes);
  }
}

/** The identity of one staged package: its predicted source modules and every staged file, each with its hash. */
function packageIdentity(composition, built, entry, packageDir, bundled) {
  const modules = new Set();
  for (const key of entry.entries) for (const module of reach(built.graph, composition.entries[key], ALL_EDGE_KINDS, true).keys()) modules.add(module);
  const unpredicted = bundled.filter((input) => !modules.has(input));
  if (unpredicted.length > 0) throw new Error(`${entry.name}: bundle contains modules the import graph did not predict: ${unpredicted.slice(0, 5).join(", ")}`);
  const sources = Object.fromEntries([...modules].sort().map((module) => [module, sha256Of(path.join(ROOT, module))]));
  const files = Object.fromEntries(filesUnder(packageDir).map((file) => [file, sha256Of(path.join(packageDir, file))]));
  return { name: entry.name, dir: path.relative(ROOT, packageDir), sources, files };
}

/** Build inputs beyond source modules: the build, copy and gate code, the boundary data, the compiler config and the lockfile. */
export const BUILD_INPUT_FILES = ["scripts/build-public-release.mjs", "scripts/copy-viewer-assets.mjs", "scripts/check-public-boundary.mjs",
  "scripts/public-boundary/graph.mjs", "scripts/public-boundary/facades.mjs", "scripts/public-boundary/surface.mjs", "scripts/public-boundary/dependencies.mjs",
  "scripts/public-boundary/artifact.mjs", "scripts/public-boundary/shapes.mjs", "scripts/public-boundary/shape-policies.mjs", "scripts/public-boundary/brands.mjs", "scripts/public-boundary/baseline.json", "tsconfig.json", "bun.lock",
  "scripts/public-boundary/composition.mjs", "scripts/public-boundary/on-demand-loads.mjs"];
/** Directory whose every file the viewer asset copy reads. */
export const VIEWER_ASSET_SOURCE = "src/viewer/assets";

/** The `path → sha256` of every build input the identity records beside the source modules. */
export function buildInputHashes(root) {
  const assets = filesUnder(path.join(root, VIEWER_ASSET_SOURCE)).map((file) => `${VIEWER_ASSET_SOURCE}/${file}`);
  return Object.fromEntries([...BUILD_INPUT_FILES, ...assets].map((file) => [file, sha256Of(path.join(root, file))]));
}

/** Stage, then record the identity that binds the stage to this exact source. */
async function main() {
  process.chdir(ROOT);
  const manifest = JSON.parse(readFileSync(path.join(BOUNDARY_DIR, "manifest.json"), "utf8"));
  const baseline = JSON.parse(readFileSync(path.join(BOUNDARY_DIR, "baseline.json"), "utf8"));
  const composition = releaseComposition(ROOT, manifest);
  const stage = path.join(ROOT, manifest.publicRelease.stageDir);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const bundled = await buildPackages(composition, stage);
  for (const dir of ["llm-wiki-compiler", "llmwiki-core"]) {
    execFileSync(process.execPath, [path.join(ROOT, "scripts/copy-viewer-assets.mjs"), path.join(manifest.publicRelease.stageDir, dir, "dist")], { cwd: ROOT });
  }
  const documents = releaseDocumentSources(ROOT, manifest, baseline.commit);
  stageReleaseDocuments(documents, baseline.commit, path.join(stage, "llm-wiki-compiler"));
  const built = buildGraph(ROOT, composition.entries, composition.graphConfig);
  const head = currentHead();
  const packages = composition.packages.map((entry) => {
    const packageDir = path.join(stage, entry.stage);
    writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify(stagedManifest(manifest, baseline, entry.name, head), null, 2)}\n`);
    return packageIdentity(composition, built, entry, packageDir, bundled[entry.name]);
  });
  const requireFrom = createRequire(import.meta.url);
  const identity = { note: "Written by scripts/build-public-release.mjs. The release gate recomputes every hash here against the current source and stage.",
    builtAt: new Date().toISOString(), head,
    publicBaselineCommit: baseline.commit, documentsFrom: `public baseline ${baseline.commit}`, coreModules: composition.moduleNames,
    manifestSha256: sha256Of(path.join(BOUNDARY_DIR, "manifest.json")), buildInputs: buildInputHashes(ROOT),
    documents,
    tools: Object.fromEntries(["tsup", "esbuild", "typescript"].map((name) => [name, requireFrom(`${name}/package.json`).version])), packages };
  writeFileSync(path.join(stage, "release-identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
  console.log(`staged ${packages.map((entry) => `${entry.name} (${Object.keys(entry.files).length} files, ${Object.keys(entry.sources).length} sources)`).join(", ")}`);
}

// Run only as a script: the gate imports this module for the build-input list.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
