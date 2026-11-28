/**
 * @file scripts/public-boundary/release-receipt.mjs
 * @description The release receipt: the three public package tarballs the
 * release gate packed and checked, carried unchanged from preflight to publish.
 *
 * `create` reads the gate's `--json` report. Every mechanism must have passed,
 * and each package's report must name the exact tarball the artifact check
 * packed and read (scripts/public-boundary/artifact.mjs). `create` re-hashes
 * those files and recomputes each one's canonical `sha512-<base64>` SRI from
 * its bytes, which must equal the integrity npm reported to the gate (the
 * value the registry will hold). It confirms each tarball's own package.json
 * (name, release version, no scripts), copies the SAME bytes into a fresh
 * directory in publication order, and writes `receipt.json`. The receipt also
 * records the release identity's `head` (which must equal `public_sha`), that
 * identity file's SHA-256, and the gate's release-readiness answer. A
 * preflight-only run records `passed: false` while release items are open; it
 * never decides readiness.
 *
 * `verify` runs in the publish job, before anything irreversible. The
 * receipt's own SHA-256 must be the value preflight reported through job
 * outputs, not one read from the artifact. Then it checks the receipt's
 * public_sha, identity head and hash, version and exact package order. Then
 * every tarball is re-hashed, its SRI recomputed and compared with the
 * receipt's integrity, and its manifest re-read.
 *
 * `registry` plans publication by identity, with one bounded
 * `npm view <name>@<version> name version dist.integrity --json` per package
 * and no retry. A version is ABSENT only when npm fails with its structured
 * JSON error `{ error: { code: "E404", detail } }` and that detail names the
 * exact requested `'<name>@<version>'`. It is PUBLISHED only when npm succeeds
 * with a JSON object whose name and version are the requested ones and whose
 * `dist.integrity` is an SRI string. Anything else is unknown and refuses the
 * whole plan before any row is printed. That covers blank success (npm prints
 * nothing when a requested field is missing), malformed or other-identity
 * output, a process error, a timeout or a signal, and an E404 for anything
 * else. A published version is skipped only when its integrity equals the
 * receipt's; other bytes or an already-published facade refuse.
 *
 * Usage (from the repository root):
 *   node scripts/public-boundary/release-receipt.mjs create <gate-report.json> <out-dir> <public_sha> <version>
 *   node scripts/public-boundary/release-receipt.mjs verify <artifact-dir> <public_sha> <version> <receipt-sha256>
 *   node scripts/public-boundary/release-receipt.mjs registry <artifact-dir> <version>
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Publication order: dependencies before the facade that pins them exactly. */
export const PUBLICATION_ORDER = Object.freeze(["@atomicstrata/llmwiki-core", "@atomicstrata/llmwiki-local-workflows", "llm-wiki-compiler"]);
/** The facade: never re-published, never skipped as "already done". */
const FACADE = "llm-wiki-compiler";
/** Every gate mechanism that must have passed in the report a receipt is made from. */
export const MECHANISMS = Object.freeze(["graph", "surface", "dependencies", "artifact", "shapes"]);
export const RECEIPT_FILE = "receipt.json";
const RECEIPT_VERSION = 1;
const TAR_MANIFEST_BYTES = 16 * 1024 * 1024;
/** A canonical sha512 SRI: `sha512-` and the 88-character base64 of a 64-byte digest. */
const SHA512_SRI = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
/** The longest a single registry lookup may take; there is no retry. */
const REGISTRY_TIMEOUT_MS = 60_000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** SHA-256 hex of one file's bytes. */
export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The canonical `sha512-<base64>` SRI of one file's bytes (what npm records as `dist.integrity`). */
export function sriOf(file) {
  return `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
}

/** Problems with one tarball's integrity: a missing or malformed value, or one that is not this file's SRI. */
function integrityProblems(file, name, integrity) {
  if (typeof integrity !== "string" || !SHA512_SRI.test(integrity)) return [`${name} integrity is not a sha512 SRI`];
  return integrity === sriOf(file) ? [] : [`${name} integrity is not this tarball's SRI`];
}

/** The package.json inside an npm tarball (its `package/` prefix). */
function tarballManifest(file) {
  return JSON.parse(execFileSync("tar", ["-xzOf", file, "package/package.json"], { encoding: "utf8", maxBuffer: TAR_MANIFEST_BYTES }));
}

/** Problems with one tarball against its expected name and version: the wrong identity, or any script at all. */
export function tarballProblems(file, name, version) {
  const manifest = tarballManifest(file);
  const problems = [];
  if (manifest.name !== name) problems.push(`${file} is ${manifest.name}, expected ${name}`);
  if (manifest.version !== version) problems.push(`${name} tarball is ${manifest.version}, expected ${version}`);
  if (Object.keys(manifest.scripts ?? {}).length > 0) problems.push(`${name} tarball carries scripts`);
  return problems;
}

/** The checked tarball of each package, in publication order, from a report whose every mechanism passed. */
export function checkedTarballs(report) {
  const failed = MECHANISMS.filter((name) => report[name]?.passed !== true);
  if (failed.length > 0) throw new Error(`gate mechanisms did not pass: ${failed.join(", ")}`);
  return PUBLICATION_ORDER.map((name) => {
    const entry = (report.artifact.packages ?? []).find((candidate) => candidate.name === name);
    if (entry?.tarball?.file === undefined) throw new Error(`the gate report names no checked tarball for ${name}`);
    return { name, ...entry.tarball };
  });
}

/** Copy one checked tarball, byte for byte, into the receipt directory; return its receipt entry. */
function carryTarball(root, outDir, tarball, version) {
  const source = path.join(root, tarball.file);
  if (sha256File(source) !== tarball.sha256) throw new Error(`${tarball.name} tarball changed after the gate checked it`);
  const problems = [...integrityProblems(source, tarball.name, tarball.integrity), ...tarballProblems(source, tarball.name, version)];
  if (problems.length > 0) throw new Error(problems.join("; "));
  const file = `${tarball.name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;
  copyFileSync(source, path.join(outDir, file), constants.COPYFILE_EXCL);
  if (sha256File(path.join(outDir, file)) !== tarball.sha256) throw new Error(`${tarball.name} tarball copy differs`);
  return { name: tarball.name, version, file, sha256: tarball.sha256, integrity: tarball.integrity };
}

/** Make the receipt directory from one gate report; refuses an existing directory or any mismatch. */
export function createReceipt({ report, identity, identitySha256, publicSha, version, outDir, root = ROOT }) {
  if (identity.head !== publicSha) throw new Error(`the stage was built at ${identity.head}, not public_sha ${publicSha}`);
  if (!SHA256_HEX.test(identitySha256 ?? "")) throw new Error("the release identity hash is not a SHA-256");
  const tarballs = checkedTarballs(report);
  mkdirSync(outDir);
  const packages = tarballs.map((tarball) => carryTarball(root, outDir, tarball, version));
  const readiness = report.releaseReadiness;
  const receipt = { receiptVersion: RECEIPT_VERSION, publicSha, version, identityHead: identity.head, identitySha256,
    readiness: { passed: readiness?.passed === true, openItems: readiness?.openItems?.length ?? null }, packages };
  writeFileSync(path.join(outDir, RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  return receipt;
}

/** Problems with one receipt entry and its tarball in `dir`. */
function entryProblems(dir, entry, name, version) {
  if (entry?.name !== name) return [`receipt package ${entry?.name} where ${name} is required`];
  if (entry.version !== version) return [`${name} receipt version ${entry.version}, expected ${version}`];
  if (typeof entry.file !== "string" || entry.file !== path.basename(entry.file)) return [`${name} receipt file is not a plain name`];
  const file = path.join(dir, entry.file);
  if (sha256File(file) !== entry.sha256) return [`${name} tarball differs from the receipt`];
  return [...integrityProblems(file, name, entry.integrity), ...tarballProblems(file, name, version)];
}

/** Verify a downloaded receipt directory against the values preflight reported; returns the receipt or throws. */
export function verifyReceipt({ dir, publicSha, version, receiptSha256 }) {
  const receiptFile = path.join(dir, RECEIPT_FILE);
  if (sha256File(receiptFile) !== receiptSha256) throw new Error("receipt.json is not the receipt preflight reported");
  const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
  const problems = [];
  if (receipt.receiptVersion !== RECEIPT_VERSION || receipt.publicSha !== publicSha || receipt.version !== version) problems.push("receipt identity differs");
  if (receipt.identityHead !== publicSha || !SHA256_HEX.test(receipt.identitySha256 ?? "")) problems.push("receipt release identity differs");
  if ((receipt.packages ?? []).length !== PUBLICATION_ORDER.length) problems.push("receipt does not list exactly the three packages");
  PUBLICATION_ORDER.forEach((name, index) => problems.push(...entryProblems(dir, receipt.packages?.[index], name, version)));
  if (problems.length > 0) throw new Error(problems.join("; "));
  return receipt;
}

/** Parse `text` as JSON, or `undefined` when it is blank or not JSON. */
function parsedJson(text) {
  try { return JSON.parse(`${text ?? ""}`); } catch { return undefined; }
}

/** Whether a failed lookup is npm's structured E404 for exactly the requested `name@version`. */
function isRequestedAbsence(entry, view) {
  const error = parsedJson(view.stdout)?.error;
  return error?.code === "E404" && typeof error.detail === "string" && error.detail.includes(`'${entry.name}@${entry.version}'`);
}

/** The registry integrity of a successful lookup, or `undefined` when its output is not exactly the requested identity. */
function publishedIntegrity(entry, view) {
  const answer = parsedJson(view.stdout);
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return undefined;
  if (answer.name !== entry.name || answer.version !== entry.version) return undefined;
  const integrity = answer["dist.integrity"];
  return typeof integrity === "string" && SHA512_SRI.test(integrity) ? integrity : undefined;
}

/**
 * `absent` or `same` for one package from its `npm view <name>@<version> name version dist.integrity --json`
 * result (`{ status, stdout, stderr, error, signal }` as spawnSync returns it); throws on anything unknown.
 */
export function registryState(entry, view) {
  if (view.error !== undefined || view.signal) throw new Error(`registry lookup for ${entry.name} did not complete; refusing the plan`);
  if (view.status !== 0) {
    if (isRequestedAbsence(entry, view)) return "absent";
    throw new Error(`registry lookup for ${entry.name}@${entry.version} failed without its structured E404; refusing the plan`);
  }
  const integrity = publishedIntegrity(entry, view);
  if (integrity === undefined) throw new Error(`registry answer for ${entry.name}@${entry.version} is not an exact identity with integrity; refusing the plan`);
  if (integrity !== entry.integrity) throw new Error(`${entry.name}@${entry.version} is already published with other bytes`);
  if (entry.name === FACADE) throw new Error(`${FACADE}@${entry.version} is already published; npm versions are immutable`);
  return "same";
}

/** The complete publication plan (`name file state`, in order) for a verified receipt, asking `lookup` once per package; any unknown answer throws before a plan exists. */
export function registryPlan(receipt, lookup) {
  return receipt.packages.map((entry) => ({ ...entry, state: registryState(entry, lookup(entry)) }));
}

/** One real registry lookup (only ever called from the `registry` command). */
function npmView(entry) {
  return spawnSync("npm", ["view", `${entry.name}@${entry.version}`, "name", "version", "dist.integrity", "--json"], { encoding: "utf8", timeout: REGISTRY_TIMEOUT_MS });
}

/** Parse arguments, run one command, print its result. */
function main([command, ...args]) {
  if (command === "create") {
    const [reportFile, outDir, publicSha, version] = args;
    const identityFile = path.join(ROOT, ".public-release/stage/release-identity.json");
    const identity = JSON.parse(readFileSync(identityFile, "utf8"));
    createReceipt({ report: JSON.parse(readFileSync(reportFile, "utf8")), identity, identitySha256: sha256File(identityFile), publicSha, version, outDir });
    console.log(sha256File(path.join(outDir, RECEIPT_FILE)));
  } else if (command === "verify") {
    const [dir, publicSha, version, receiptSha256] = args;
    verifyReceipt({ dir, publicSha, version, receiptSha256 });
    console.log("verified");
  } else if (command === "registry") {
    const [dir, version] = args;
    const receipt = JSON.parse(readFileSync(path.join(dir, RECEIPT_FILE), "utf8"));
    if (receipt.version !== version) throw new Error("receipt version differs");
    for (const step of registryPlan(receipt, npmView)) console.log(`${step.name}\t${step.file}\t${step.state}`);
  } else {
    throw new Error("usage: release-receipt.mjs create|verify|registry ...");
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
