/**
 * @file test/public-boundary/release-receipt.test.mjs
 * @description The release receipt (scripts/public-boundary/release-receipt.mjs)
 * on synthetic tarballs, made with the system `tar` in a temporary directory.
 * No npm, registry, network, build or package install is involved; registry
 * answers are synthetic `spawnSync`-shaped objects.
 *
 * Witnessed:
 *  - `createReceipt` carries the very bytes the gate report names, in
 *    publication order (core, local-workflows, facade), with each tarball's
 *    real sha512 SRI, and records the release identity's head and the
 *    readiness answer (false while items are open);
 *  - it refuses a failed mechanism, a package without a checked tarball, a
 *    stage built at another commit, a malformed identity hash, a tarball
 *    changed after the gate, the wrong version, any scripts, an existing
 *    output directory, and a reported integrity that is missing, malformed
 *    or not the tarball's own SRI;
 *  - `verifyReceipt` accepts the untouched directory and refuses an
 *    unreported receipt hash, a tampered tarball, a reordered receipt, and,
 *    even with the receipt hash taken as reported, a missing, malformed or
 *    wrong integrity and a wrong identity head;
 *  - `registryPlan` calls a version absent only on npm's structured E404 for
 *    exactly that name@version and published only on an exact identity with an
 *    SRI. It skips only identical bytes. It refuses other bytes, a published
 *    facade, blank success, a missing field, another identity, malformed
 *    output, an E404 for another resource or only on stderr, and a timeout. An
 *    unknown LATER package refuses the whole plan.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MECHANISMS, PUBLICATION_ORDER, RECEIPT_FILE, createReceipt, registryPlan, sha256File, sriOf, verifyReceipt } from "../../scripts/public-boundary/release-receipt.mjs";

const SHA = "a".repeat(40);
const VERSION = "1.6.0";

let root;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "llmwiki-receipt-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** Pack one synthetic npm tarball (`package/package.json`) under the gate's pack-check directory; returns its gate record. */
function makeTarball(name, manifest = {}) {
  const stage = name.replace(/^@atomicstrata\//u, "");
  const source = path.join(root, "src", stage, "package");
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, "package.json"), JSON.stringify({ name, version: VERSION, ...manifest }));
  const dir = path.join(root, ".public-release/pack-check", stage);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stage}-${VERSION}.tgz`);
  execFileSync("tar", ["-czf", file, "-C", path.dirname(source), "package"]);
  return { file: path.relative(root, file), sha256: sha256File(file), integrity: sriOf(file) };
}

/** A gate report whose every mechanism passed, naming one checked tarball per package. */
function gateReport(overrides = {}) {
  const report = Object.fromEntries(MECHANISMS.map((name) => [name, { passed: true }]));
  report.artifact.packages = PUBLICATION_ORDER.map((name) => ({ name, tarball: makeTarball(name, overrides[name]) }));
  report.releaseReadiness = { passed: false, openItems: [{ id: "open" }] };
  return report;
}

/** Create a receipt in `<root>/out` from `report`, with the stage built at `head` and the identity hash `identitySha256`. */
function create(report, head = SHA, identitySha256 = "f".repeat(64)) {
  return createReceipt({ report, identity: { head }, identitySha256, publicSha: SHA, version: VERSION, outDir: path.join(root, "out"), root });
}

/** Rewrite `<root>/out/receipt.json` through `edit` and return the new receipt's hash, as if preflight had reported it. */
function rewriteReceipt(edit) {
  const receiptFile = path.join(root, "out", RECEIPT_FILE);
  writeFileSync(receiptFile, JSON.stringify(edit(JSON.parse(readFileSync(receiptFile, "utf8")))));
  return sha256File(receiptFile);
}

/** A well-formed sha512 SRI that is not any fixture tarball's. */
const OTHER_SRI = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

/** Verify `<root>/out` against the receipt hash `sha`. */
function verify(sha = sha256File(path.join(root, "out", RECEIPT_FILE))) {
  return verifyReceipt({ dir: path.join(root, "out"), publicSha: SHA, version: VERSION, receiptSha256: sha });
}

describe("createReceipt", () => {
  it("carries the checked bytes in publication order and records head and readiness", () => {
    const report = gateReport();
    const receipt = create(report);
    expect(receipt.packages.map((entry) => entry.name)).toEqual([...PUBLICATION_ORDER]);
    for (const [index, entry] of receipt.packages.entries()) {
      expect(sha256File(path.join(root, "out", entry.file))).toBe(report.artifact.packages[index].tarball.sha256);
      expect([entry.sha256, entry.integrity, entry.version]).toEqual([report.artifact.packages[index].tarball.sha256, report.artifact.packages[index].tarball.integrity, VERSION]);
    }
    expect([receipt.publicSha, receipt.identityHead, receipt.readiness]).toEqual([SHA, SHA, { passed: false, openItems: 1 }]);
  });

  it("refuses a failed mechanism, a missing checked tarball, another build commit and an existing directory", () => {
    const failed = gateReport();
    failed.shapes.passed = false;
    expect(() => create(failed)).toThrow("gate mechanisms did not pass: shapes");
    const missing = gateReport();
    delete missing.artifact.packages[1].tarball;
    expect(() => create(missing)).toThrow("names no checked tarball for @atomicstrata/llmwiki-local-workflows");
    expect(() => create(gateReport(), "b".repeat(40))).toThrow("not public_sha");
    expect(() => create(gateReport(), SHA, "not-a-hash")).toThrow("identity hash is not a SHA-256");
    mkdirSync(path.join(root, "out"));
    expect(() => create(gateReport())).toThrow();
  });

  it("refuses a tarball changed after the gate, the wrong version and any scripts", () => {
    const changed = gateReport();
    writeFileSync(path.join(root, changed.artifact.packages[0].tarball.file), "replaced");
    expect(() => create(changed)).toThrow("changed after the gate checked it");
    /** Start the next case from a fresh pack-check and output directory. */
    const reset = () => ["out", ".public-release"].forEach((dir) => rmSync(path.join(root, dir), { recursive: true, force: true }));
    reset();
    expect(() => create(gateReport({ "llm-wiki-compiler": { version: "9.9.9" } }))).toThrow("expected 1.6.0");
    reset();
    expect(() => create(gateReport({ "@atomicstrata/llmwiki-core": { scripts: { prepare: "x" } } }))).toThrow("carries scripts");
  });
});

describe("createReceipt integrity", () => {
  it("refuses a reported integrity that is missing, malformed or not the tarball's own SRI", () => {
    for (const [integrity, message] of [[undefined, "integrity is not a sha512 SRI"], ["sha512-short", "integrity is not a sha512 SRI"], [OTHER_SRI, "integrity is not this tarball's SRI"]]) {
      ["out", ".public-release"].forEach((dir) => rmSync(path.join(root, dir), { recursive: true, force: true }));
      const report = gateReport();
      report.artifact.packages[1].tarball.integrity = integrity;
      expect(() => create(report)).toThrow(`@atomicstrata/llmwiki-local-workflows ${message}`);
    }
  });
});

describe("verifyReceipt", () => {
  it("accepts the untouched directory and refuses an unreported hash, a tampered tarball and a reordered receipt", () => {
    create(gateReport());
    expect(verify().packages).toHaveLength(3);
    expect(() => verify("0".repeat(64))).toThrow("not the receipt preflight reported");
    const receiptFile = path.join(root, "out", RECEIPT_FILE);
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    writeFileSync(receiptFile, JSON.stringify({ ...receipt, packages: [...receipt.packages].reverse() }));
    expect(() => verify()).toThrow("where @atomicstrata/llmwiki-core is required");
    writeFileSync(receiptFile, JSON.stringify(receipt));
    writeFileSync(path.join(root, "out", receipt.packages[2].file), "tampered");
    expect(() => verify()).toThrow("llm-wiki-compiler tarball differs from the receipt");
  });

  it("refuses invalid receipt content even when its hash is the one preflight reported", () => {
    create(gateReport());
    const cases = [[(r) => ({ ...r, packages: r.packages.map((p, i) => (i === 0 ? { ...p, integrity: undefined } : p)) }), "integrity is not a sha512 SRI"],
      [(r) => ({ ...r, packages: r.packages.map((p, i) => (i === 0 ? { ...p, integrity: "sha512-x" } : p)) }), "integrity is not a sha512 SRI"],
      [(r) => ({ ...r, packages: r.packages.map((p, i) => (i === 0 ? { ...p, integrity: OTHER_SRI } : p)) }), "integrity is not this tarball's SRI"],
      [(r) => ({ ...r, identityHead: "c".repeat(40) }), "receipt release identity differs"]];
    const original = JSON.parse(readFileSync(path.join(root, "out", RECEIPT_FILE), "utf8"));
    for (const [edit, message] of cases) {
      const reported = rewriteReceipt(() => edit(original));
      expect(() => verify(reported)).toThrow(message);
    }
  });
});

/** A distinct well-formed sha512 SRI per package name (registry fixtures only). */
const sri = (name) => `sha512-${Buffer.alloc(64, name.length).toString("base64")}`;
const registryReceipt = { packages: PUBLICATION_ORDER.map((name) => ({ name, version: VERSION, file: `${name}.tgz`, integrity: sri(name) })) };
/** A successful structured answer for `entry`, with `changes` applied. */
const found = (entry, changes = {}) => ({ status: 0, stdout: JSON.stringify({ name: entry.name, version: entry.version, "dist.integrity": entry.integrity, ...changes }), stderr: "" });
/** npm's structured `--json` E404 for the resource `id`. */
const e404 = (id) => ({ status: 1, stdout: JSON.stringify({ error: { code: "E404", summary: "No match found", detail: `The requested resource '${id}' could not be found or you do not have permission to access it.` } }), stderr: "" });
/** The structured E404 for exactly `entry`'s name@version. */
const missing = (entry) => e404(`${entry.name}@${entry.version}`);

describe("registryPlan identity", () => {
  const receipt = registryReceipt;

  it("plans absent only on the exact structured E404 and skips only identical bytes", () => {
    const plan = registryPlan(receipt, (entry) => (entry.name === PUBLICATION_ORDER[0] ? found(entry) : missing(entry)));
    expect(plan.map((step) => step.state)).toEqual(["same", "absent", "absent"]);
  });

  it("refuses other bytes and an already-published facade", () => {
    expect(() => registryPlan(receipt, (entry) => found(entry, { "dist.integrity": OTHER_SRI }))).toThrow("already published with other bytes");
    expect(() => registryPlan(receipt, (entry) => (entry.name === "llm-wiki-compiler" ? found(entry) : missing(entry)))).toThrow("npm versions are immutable");
  });
});

describe("registryPlan unknown answers", () => {
  const receipt = registryReceipt;

  it("treats blank success, missing fields, another identity and malformed output as unknown", () => {
    const answers = [{ status: 0, stdout: "", stderr: "" }, (entry) => found(entry, { "dist.integrity": undefined }),
      (entry) => found(entry, { version: "9.9.9" }), (entry) => found(entry, { name: "other" }), { status: 0, stdout: "{not json", stderr: "" },
      (entry) => found(entry, { "dist.integrity": "sha512-short" })];
    for (const answer of answers) {
      expect(() => registryPlan(receipt, (entry) => (typeof answer === "function" ? answer(entry) : answer))).toThrow("refusing the plan");
    }
  });

  it("treats an E404 for another resource, an E404 only on stderr and a timeout as unknown", () => {
    expect(() => registryPlan(receipt, (entry) => e404(entry.name))).toThrow("without its structured E404");
    expect(() => registryPlan(receipt, () => ({ status: 1, stdout: "", stderr: "npm error code E404" }))).toThrow("without its structured E404");
    const timedOut = { status: null, stdout: "", stderr: "", signal: "SIGTERM", error: Object.assign(new Error("spawnSync npm ETIMEDOUT"), { code: "ETIMEDOUT" }) };
    expect(() => registryPlan(receipt, () => timedOut)).toThrow("did not complete");
  });

  it("refuses the whole plan when a LATER package is unknown, after looking up every earlier one", () => {
    const asked = [];
    const lookup = (entry) => { asked.push(entry.name); return entry.name === "llm-wiki-compiler" ? { status: 0, stdout: "", stderr: "" } : missing(entry); };
    let plan;
    expect(() => { plan = registryPlan(receipt, lookup); }).toThrow("refusing the plan");
    expect([plan, asked]).toEqual([undefined, [...PUBLICATION_ORDER]]);
  });
});
