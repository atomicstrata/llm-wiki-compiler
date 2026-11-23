/**
 * @file test/public-boundary/shape-baseline-cache.test.mjs
 * @description Exercise the public shape checker against an isolated local Git
 * baseline. The historical manifest differs from the working tree's manifest.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkShapes } from "../../scripts/public-boundary/shapes.mjs";

const { test } = process.versions.bun ? await import("bun:test") : await import("node:test");
// These cases use Node's live builtin binding synchronization to inject at publication.
const nodeTest = process.versions.bun ? test.skip : test;

const historicalManifest = '{ "name": "shape-cache-fixture", "version": "1.0.0" }\n';
const candidateManifest = '{"name":"shape-cache-fixture","version":"2.0.0"}\n';
const facade = 'export { version } from "./version.js";\n';
const versionSource = 'import manifest from "../package.json";\nexport const version = manifest.version;\n';
const manifest = {
  publicRelease: { stageDir: ".public-release/stage" },
  packageEntries: {},
  surface: { facades: {
    core: { internal: "src/core-index.ts", public: "src/core-index.ts" },
    root: { internal: "src/index.ts", public: "src/index.ts" },
  } },
};

/** Write files beneath this fixture, creating their parent directories. */
function write(directory, relative, bytes) {
  const file = path.join(directory, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

/** Run only fixture Git with isolated configuration and disabled hooks and signing. */
function git(root, args) {
  const env = {
    PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, ".config"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", TZ: "UTC",
  };
  const config = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false",
    "-c", "maintenance.auto=false", "-c", "gc.auto=0",
    "-c", "user.name=Shape Fixture", "-c", "user.email=shape@example.invalid"];
  return execFileSync("git", ["-C", root, ...config, ...args], { encoding: "utf8", env, timeout: 5_000 });
}

/** Create distinct historical and candidate inputs, then clean up the private repository. */
function withFixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "shape-baseline-cache-"));
  try {
    write(root, "package.json", historicalManifest);
    write(root, "src/core-index.ts", facade);
    write(root, "src/index.ts", facade);
    write(root, "src/version.ts", versionSource);
    git(root, ["init", "--quiet", "--template="]);
    git(root, ["add", "--", "package.json", "src"]);
    git(root, ["commit", "--quiet", "--no-gpg-sign", "-m", "baseline"]);
    const commit = git(root, ["rev-parse", "HEAD"]).trim();
    assert.equal(git(root, ["show", `${commit}:package.json`]), historicalManifest);
    write(root, "package.json", candidateManifest);
    write(root, "src/version.ts", `// Ensure each tree resolves its own package manifest.\n${versionSource}`);
    run(root, { commit, exports: { core: ["version"], root: ["version"] } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The commit-specific on-disk cache used by the shape checker. */
function cached(root, baseline) {
  return path.join(root, ".public-release/baseline-with-manifest-v1", baseline.commit);
}

/** Check the exact archive bytes, comparison, and working tree together. */
function assertComplete(root, baseline) {
  const result = checkShapes(root, manifest, baseline);
  const cache = cached(root, baseline);
  assert.equal(existsSync(path.join(cache, "package.json")), true, "baseline cache is missing the historical package.json");
  assert.deepEqual(readFileSync(path.join(cache, "package.json")), Buffer.from(historicalManifest));
  assert.deepEqual(readFileSync(path.join(root, "package.json")), Buffer.from(candidateManifest));
  assert.equal(readFileSync(path.join(cache, "src/version.ts"), "utf8"), versionSource);
  assert.equal(result.baselineCommit, baseline.commit);
  assert.deepEqual(result.findings, []);
  assert.equal(result.passed, true);
}

test("retains the source-only cache and reuses the new complete baseline without Git", () => {
  withFixture((root, baseline) => {
    const legacy = path.join(root, ".public-release/baseline", baseline.commit);
    writeSources(legacy);
    write(legacy, "src/stale.ts", "export {};\n");
    const inode = lstatSync(legacy).ino;
    assertComplete(root, baseline);
    assert.equal(lstatSync(legacy).ino, inode);
    assert.equal(readFileSync(path.join(legacy, "src/stale.ts"), "utf8"), "export {};\n");
    assert.equal(existsSync(path.join(legacy, "package.json")), false);
    assert.equal(existsSync(path.join(cached(root, baseline), "src/stale.ts")), false);
    assertNoTemporarySiblings(root, baseline);
    renameSync(path.join(root, ".git"), path.join(root, ".git-unavailable"));
    assertComplete(root, baseline);
  });
});

test("does not publish an incomplete extraction and recovers on retry", () => {
  withFixture((root, baseline) => {
    const attributes = path.join(root, ".git/info/attributes");
    // Git archives the source but omits the manifest for this attempt.
    write(root, ".git/info/attributes", "package.json export-ignore\n");
    assert.throws(() => checkShapes(root, manifest, baseline), /baseline archive is missing src or package\.json/u);
    const cache = cached(root, baseline);
    assert.equal(existsSync(cache), false);
    assert.deepEqual(readdirSync(path.dirname(cache)), []);
    rmSync(attributes);
    assertComplete(root, baseline);
  });
});

/** Write the same three source files as the archived commit. */
function writeSources(directory) {
  write(directory, "src/core-index.ts", facade);
  write(directory, "src/index.ts", facade);
  write(directory, "src/version.ts", versionSource);
}

/** Insert a competing destination immediately before the relevant filesystem operation. */
function atPublication(root, baseline, before, run) {
  const fs = createRequire(import.meta.url)("node:fs");
  const { renameSync: rename, rmSync: remove } = fs;
  const previous = path.join(root, ".public-release/baseline", baseline.commit);
  const destination = cached(root, baseline);
  const observed = {};
  const publish = (target, operation) => {
    assert.equal(observed.target, undefined, "publication hook called more than once");
    observed.target = target;
    observed.operation = operation;
    before(target);
  };
  fs.rmSync = (target, options) => {
    // Reproduce the previous loader's race after its final completeness check.
    if (target === previous) publish(target, "remove");
    return remove(target, options);
  };
  fs.renameSync = (from, to) => {
    if (to === destination) publish(to, "rename");
    try {
      return rename(from, to);
    } catch (error) {
      if (to === destination) observed.renameError = error;
      throw error;
    }
  };
  syncBuiltinESMExports();
  try {
    run(observed);
  } finally {
    fs.renameSync = rename;
    fs.rmSync = remove;
    syncBuiltinESMExports();
  }
}

/** Publish an independently marked complete cache and return its directory identity. */
function writeWinner(directory) {
  writeSources(directory);
  write(directory, "package.json", historicalManifest);
  write(directory, "winner.txt", "competing process\n");
  return lstatSync(directory).ino;
}

/** The published entry is the only sibling left after extraction. */
function assertNoTemporarySiblings(root, baseline) {
  assert.deepEqual(readdirSync(path.dirname(cached(root, baseline))), [baseline.commit]);
}

nodeTest("keeps the complete cache published by a competing checker", () => {
  withFixture((root, baseline) => {
    let inode;
    atPublication(root, baseline, (destination) => {
      inode = writeWinner(destination);
    }, (observed) => {
      const result = checkShapes(root, manifest, baseline);
      assert.equal(result.passed, true);
      assert.equal(existsSync(path.join(observed.target, "winner.txt")), true, "competing baseline directory was replaced");
      assert.equal(observed.operation, "rename");
      assert.match(observed.renameError.code, /^(EEXIST|ENOTEMPTY)$/u);
      assert.equal(lstatSync(observed.target).ino, inode);
      assert.equal(readFileSync(path.join(observed.target, "winner.txt"), "utf8"), "competing process\n");
    });
    assertComplete(root, baseline);
    assertNoTemporarySiblings(root, baseline);
  });
});

nodeTest("reports a rename collision with an incomplete competing destination", () => {
  withFixture((root, baseline) => {
    let inode;
    atPublication(root, baseline, (destination) => {
      write(destination, "incomplete.txt", "unfinished\n");
      inode = lstatSync(destination).ino;
    }, (observed) => {
      assert.throws(() => checkShapes(root, manifest, baseline), (error) => error === observed.renameError);
      assert.match(observed.renameError.code, /^(EEXIST|ENOTEMPTY)$/u);
      assert.equal(lstatSync(observed.target).ino, inode);
      assert.equal(readFileSync(path.join(observed.target, "incomplete.txt"), "utf8"), "unfinished\n");
    });
    assertNoTemporarySiblings(root, baseline);
  });
});

nodeTest("reports an unrelated rename error even with a complete competing cache", () => {
  withFixture((root, baseline) => {
    let inode;
    const denied = Object.assign(new Error("fixture denied publication"), { code: "EACCES" });
    atPublication(root, baseline, (destination) => {
      inode = writeWinner(destination);
      throw denied;
    }, (observed) => {
      assert.throws(() => checkShapes(root, manifest, baseline), (error) => error === denied);
      assert.equal(observed.operation, "rename");
      assert.equal(lstatSync(observed.target).ino, inode);
    });
    assertNoTemporarySiblings(root, baseline);
  });
});

test("preserves and reports a preexisting empty cache directory", () => {
  withFixture((root, baseline) => {
    const cache = cached(root, baseline);
    mkdirSync(cache, { recursive: true });
    const inode = lstatSync(cache).ino;
    assert.throws(() => checkShapes(root, manifest, baseline), /baseline cache is missing src or package\.json/u);
    assert.deepEqual(readdirSync(cache), []);
    assert.equal(lstatSync(cache).ino, inode);
    assertNoTemporarySiblings(root, baseline);
  });
});
