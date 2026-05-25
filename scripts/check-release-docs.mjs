/**
 * Guards release documentation.
 *
 * Diff mode is intended for CI: if package.json changes the package version,
 * README.md and CHANGELOG.md must also change and mention the new version.
 *
 * Current-version mode is intended for npm publish: the current package
 * version must already be present in both public docs, independent of git diff
 * state.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REQUIRED_DOCS = ["README.md", "CHANGELOG.md"];

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));
}

function readText(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function runGit(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(args) {
  try {
    return runGit(args);
  } catch {
    return "";
  }
}

function getBaseRef() {
  if (process.env.RELEASE_DOCS_BASE) {
    return process.env.RELEASE_DOCS_BASE;
  }
  if (process.env.GITHUB_BASE_REF) {
    return `origin/${process.env.GITHUB_BASE_REF}`;
  }
  return "origin/main";
}

function getMergeBase() {
  const baseRef = getBaseRef();
  const mergeBase = tryGit(["merge-base", "HEAD", baseRef]);
  if (mergeBase) {
    return mergeBase;
  }
  console.error(`Could not find merge-base with ${baseRef}; skipping diff-based release docs check.`);
  return "";
}

function getVersionAt(ref) {
  const rawPackageJson = tryGit(["show", `${ref}:package.json`]);
  if (!rawPackageJson) {
    return "";
  }
  return JSON.parse(rawPackageJson).version ?? "";
}

function getChangedFiles(baseRef) {
  return new Set(runGit(["diff", "--name-only", `${baseRef}...HEAD`]).split("\n").filter(Boolean));
}

function assertDocsMentionVersion(version) {
  const missingDocs = REQUIRED_DOCS.filter((doc) => !readText(doc).includes(version));
  if (missingDocs.length === 0) {
    return;
  }
  console.error(`Release docs must mention version ${version}: ${missingDocs.join(", ")}`);
  process.exit(1);
}

function assertDocsChanged(changedFiles) {
  const unchangedDocs = REQUIRED_DOCS.filter((doc) => !changedFiles.has(doc));
  if (unchangedDocs.length === 0) {
    return;
  }
  console.error(`Version bump requires docs changes: ${unchangedDocs.join(", ")}`);
  process.exit(1);
}

function checkCurrentVersion() {
  const currentVersion = readJson("package.json").version;
  assertDocsMentionVersion(currentVersion);
}

function checkVersionBumpDocs() {
  const mergeBase = getMergeBase();
  if (!mergeBase) {
    return;
  }

  const currentVersion = readJson("package.json").version;
  const baseVersion = getVersionAt(mergeBase);
  if (!baseVersion || currentVersion === baseVersion) {
    return;
  }

  const changedFiles = getChangedFiles(mergeBase);
  assertDocsChanged(changedFiles);
  assertDocsMentionVersion(currentVersion);
}

if (process.argv.includes("--current-version")) {
  checkCurrentVersion();
} else {
  checkVersionBumpDocs();
}
