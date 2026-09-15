/**
 * Pack-and-install smoke test.
 *
 * Reproduces what end users actually do: `npm install llm-wiki-compiler`.
 * Our standard test suite installs from the locked dependency tree, which
 * masks bugs that only appear when transitive deps resolve fresh. v0.5.0
 * shipped with a startup crash for exactly this reason — `youtube-transcript`
 * 1.3.1 added an exports map that hid the deep import we were using, but
 * our lockfile pinned 1.3.0 so CI never saw it.
 *
 * What this test does:
 *  1. `npm pack` to produce the same tarball npm publishes.
 *  2. Install that tarball into a throwaway directory (no lockfile from
 *     this repo, so deps resolve fresh against the registry).
 *  3. Invoke the installed `llmwiki` binary with `--version`, `--help`,
 *     and `ingest --help`. Any crash or non-zero exit fails the test.
 *
 * Because installing all production deps fresh is slow (~30–60s) and
 * requires registry access, the test is skipped locally by default. It
 * runs automatically in CI (where `CI=true` is set), and devs can force
 * it locally via `RUN_PACK_INSTALL_SMOKE=1 npm test`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, rm, writeFile } from "fs/promises";
import path from "path";
import { tmpdir } from "os";
import { npmCommand } from "./fixtures/npm-command.js";

const exec = promisify(execFile);

/** Matches CI environments (GitHub Actions sets CI=true). */
const SHOULD_RUN =
  process.env.CI === "true" || process.env.RUN_PACK_INSTALL_SMOKE === "1";

/** npm install over the network can be slow; give it a generous ceiling. */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

interface PackedTarball {
  /** Absolute path to the tarball file. */
  path: string;
  /** Directory the tarball lives in (caller must clean up). */
  dir: string;
}

/**
 * Run `npm pack` against the current project and return the tarball path.
 * Uses --json so we don't have to parse the human-readable output.
 */
async function packProject(): Promise<PackedTarball> {
  const dir = await mkdtemp(path.join(tmpdir(), "llmwiki-pack-"));
  const { stdout } = await exec(
    ...npmCommand(["pack", "--pack-destination", dir, "--json", "--ignore-scripts"]),
    { cwd: process.cwd() },
  );
  const parsed = JSON.parse(stdout) as Array<{ filename: string }>;
  return { path: path.join(dir, parsed[0].filename), dir };
}

/**
 * Install a tarball into the given empty project directory. Deps resolve
 * against the live registry — no lockfile inheritance from llmwiki itself
 * — so this mirrors what `npm install -g llm-wiki-compiler` does for end
 * users. Caller owns `root` lifecycle so an install failure still leaves
 * a known directory for afterAll cleanup.
 */
async function installTarballInto(root: string, tarballPath: string): Promise<string> {
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "llmwiki-smoke", version: "1.0.0", private: true })}\n`,
    "utf-8",
  );
  await exec(...npmCommand(["install", "--no-fund", "--no-audit", tarballPath]), {
    cwd: root,
    timeout: INSTALL_TIMEOUT_MS,
  });
  return process.platform === "win32"
    ? path.join(root, "node_modules", "llm-wiki-compiler", "dist", "cli.js")
    : path.join(root, "node_modules", ".bin", "llmwiki");
}

/** POSIX executes the installed bin link; Windows needs Node, not a .cmd shim. */
function installedCommand(bin: string, args: string[]): [string, string[]] {
  return process.platform === "win32" ? [process.execPath, [bin, ...args]] : [bin, args];
}

const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

describeOrSkip("pack-and-install smoke", () => {
  let tarball: PackedTarball | null = null;
  let installRoot: string | null = null;
  let bin: string;

  beforeAll(async () => {
    // Create both temp dirs upfront so afterAll can clean them up even
    // when pack or install throws partway through.
    installRoot = await mkdtemp(path.join(tmpdir(), "llmwiki-install-"));
    tarball = await packProject();
    bin = await installTarballInto(installRoot, tarball.path);
  }, INSTALL_TIMEOUT_MS + 60_000);

  afterAll(async () => {
    if (installRoot) await rm(installRoot, { recursive: true, force: true });
    if (tarball) await rm(tarball.dir, { recursive: true, force: true });
  });

  it("--version prints a semver string", async () => {
    const { stdout } = await exec(...installedCommand(bin, ["--version"]));
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("--help lists the core commands", async () => {
    const { stdout } = await exec(...installedCommand(bin, ["--help"]));
    expect(stdout).toContain("ingest");
    expect(stdout).toContain("compile");
    expect(stdout).toContain("query");
  });

  it("ingest --help exits cleanly", async () => {
    const { stdout } = await exec(...installedCommand(bin, ["ingest", "--help"]));
    expect(stdout).toContain("ingest");
  });
});
