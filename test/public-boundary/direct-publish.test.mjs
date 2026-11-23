/**
 * @file test/public-boundary/direct-publish.test.mjs
 * @description Witnesses that the only release path is the checked stage:
 * every public package refuses a publish from the source tree, the refusal
 * script exits non-zero and names the staged path, and a stage that was
 * tampered with (a staged file edited, added or removed, or a source edited
 * after staging) no longer matches its recorded identity. Plain JavaScript on
 * purpose: it imports the gate's `.mjs` modules directly. Nothing is packed,
 * published or sent anywhere.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { releaseDocumentSources } from "../../scripts/build-public-release.mjs";
import { documentFindings, hashFindings } from "../../scripts/public-boundary/artifact.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, "scripts/public-boundary/manifest.json"), "utf8"));
const REFUSAL = "scripts/refuse-direct-publish.mjs";

describe("publishing from the source tree is refused", () => {
  it.each(MANIFEST.publicPackages.map((entry) => [entry.name, entry.dir]))("%s runs the refusal as its prepublishOnly", (_name, dir) => {
    const scripts = JSON.parse(readFileSync(path.join(ROOT, dir, "package.json"), "utf8")).scripts;
    const [command, script] = scripts.prepublishOnly.split(" ");
    expect(command).toBe("node");
    expect(path.resolve(ROOT, dir, script)).toBe(path.join(ROOT, REFUSAL));
    expect(Object.keys(scripts).filter((name) => name === "publish" || name === "postpublish")).toEqual([]);
  });

  it("exits non-zero, writes nothing to stdout and names the staged path", () => {
    const run = spawnSync(process.execPath, [path.join(ROOT, REFUSAL)], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/Refusing to publish from the source tree/u);
    expect(run.stderr).toMatch(/\.public-release\/stage\/<package>/u);
  });
});

describe("a tampered stage no longer matches its recorded identity", () => {
  const recorded = { "dist/index.js": "hash-index", "dist/cli.js": "hash-cli", "package.json": "hash-manifest" };

  it("accepts the stage exactly as recorded", () => {
    expect(hashFindings("staged-file", recorded, { ...recorded })).toEqual([]);
  });

  it.each([
    ["an edited staged file", { ...recorded, "dist/cli.js": "edited" }, ["staged-file-changed:dist/cli.js"]],
    ["an added staged file", { ...recorded, "dist/extra.js": "hash-extra" }, ["staged-file-not-in-identity:dist/extra.js"]],
    ["a removed staged file", { "dist/index.js": "hash-index", "package.json": "hash-manifest" }, ["staged-file-missing:dist/cli.js"]],
    ["an edited manifest", { ...recorded, "package.json": "edited" }, ["staged-file-changed:package.json"]],
  ])("refuses %s", (_label, current, expected) => {
    expect(hashFindings("staged-file", recorded, current).map((finding) => `${finding.kind}:${finding.file}`)).toEqual(expected);
  });

  it("refuses a source or build input edited after staging", () => {
    expect(hashFindings("source", { "src/a.ts": "h" }, { "src/a.ts": "edited" })).toEqual([{ kind: "source-changed", file: "src/a.ts" }]);
    expect(hashFindings("build-input", { "package-lock.json": "h" }, { "package-lock.json": "edited" })).toEqual([{ kind: "build-input-changed", file: "package-lock.json" }]);
  });
});

describe("release documents are bound to their declared source", () => {
  const BOUNDARY = { publicRelease: { stageDir: ".public-release/stage" }, publicPackages: [{ name: "pkg", dir: ".", stage: "pkg" }],
    artifact: { releaseDocuments: { fromWorkingTree: ["README.md", "skills"], fromBaseline: [] } } };
  let root;
  let identity;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "release-documents-"));
    for (const [file, text] of Object.entries({ "README.md": "reviewed", "skills/tool/SKILL.md": "skill" })) {
      for (const base of [root, path.join(root, ".public-release/stage/pkg")]) {
        mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
        writeFileSync(path.join(base, file), text);
      }
    }
    identity = { documents: releaseDocumentSources(root, BOUNDARY, "unused") };
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** The kinds and files of the document findings now. */
  const findings = () => documentFindings(root, BOUNDARY, { commit: "unused" }, identity).map((finding) => `${finding.kind}:${finding.file}`).sort();

  it("accepts documents that are exactly their recorded sources, expanded from a declared directory", () => {
    expect(Object.keys(identity.documents).sort()).toEqual(["README.md", "skills/tool/SKILL.md"]);
    expect(findings()).toEqual([]);
  });

  it("refuses a source document edited after staging", () => {
    writeFileSync(path.join(root, "README.md"), "edited after staging");
    expect(findings()).toEqual(["release-document-changed:README.md", "staged-release-document-differs-from-source:README.md"]);
  });

  it("refuses a staged copy that is not its source, and a document added to a declared directory", () => {
    writeFileSync(path.join(root, ".public-release/stage/pkg/README.md"), "tampered");
    writeFileSync(path.join(root, "skills/tool/EXTRA.md"), "not staged");
    expect(findings()).toEqual(["release-document-not-in-identity:skills/tool/EXTRA.md", "staged-release-document-differs-from-source:README.md", "staged-release-document-differs-from-source:skills/tool/EXTRA.md"]);
  });
});
