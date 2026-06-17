/**
 * @file test/profile-cli.test.ts
 * @description Subprocess tests for the read-only `profile` CLI group
 * (CLP Phase 0/1, Task 8).
 *
 * Covers: `profile show` prints profileId + digest; `profile validate` exits 0
 * for a valid profile and non-zero with a clear message for an invalid one; and
 * the Codex-reviewed no-data-loss `profile diff --candidate` test — diffing the
 * active profile A against an uninstalled candidate B asserts the expected
 * dispositions AND that `.llmwiki/profile.json` and the entire wiki tree are
 * BYTE-IDENTICAL before and after the diff (the diff writes nothing).
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCLI } from "./fixtures/run-cli.js";
import { buildResearchLiteProject } from "./fixtures/profile-fixtures.js";
import { PROFILE_FILE } from "../src/utils/constants.js";

let root = "";

/** Profile A: the active on-disk profile for the no-data-loss diff test. */
const PROFILE_A = {
  schemaVersion: 1,
  profileId: "research-a",
  entities: {
    papers: { directory: "wiki/papers" },
    ideas: { directory: "wiki/ideas" },
    "legacy-notes": { directory: "wiki/legacy-notes" },
  },
};

/** Profile B: removes legacy-notes, moves ideas, adds experiments. Uninstalled. */
const PROFILE_B = {
  schemaVersion: 1,
  profileId: "research-b",
  entities: {
    papers: { directory: "wiki/papers" },
    ideas: { directory: "wiki/ideas-v2" },
    experiments: { directory: "wiki/experiments" },
  },
};

/** Write a slug-safe page under a repo-relative directory. */
async function writePage(dir: string, slug: string): Promise<void> {
  await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, dir, `${slug}.md`), `# ${slug}\n`, "utf8");
}

/** Snapshot the whole project tree as `{ relPath: bytes }` for byte-identity. */
async function snapshotTree(dir: string, base = dir, out: Record<string, string> = {}): Promise<Record<string, string>> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await snapshotTree(full, base, out);
    else out[path.relative(base, full)] = await readFile(full, "utf8");
  }
  return out;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "profile-cli-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("profile show / validate", () => {
  it("show prints the profileId and digest", async () => {
    await buildResearchLiteProject(root);
    const result = await runCLI(["profile", "show"], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("research-lite");
    expect(result.stdout).toMatch(/digest:\s+[0-9a-f]{64}/);
  });

  it("validate exits 0 for a valid profile", async () => {
    await buildResearchLiteProject(root);
    const result = await runCLI(["profile", "validate"], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("valid");
  });

  it("validate exits non-zero with a message for an invalid profile", async () => {
    await mkdir(path.join(root, ".llmwiki"), { recursive: true });
    await writeFile(path.join(root, PROFILE_FILE), JSON.stringify({ schemaVersion: 2, profileId: "x", entities: {} }), "utf8");
    const result = await runCLI(["profile", "validate"], root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/schemaVersion/);
  });
});

describe("profile diff --candidate — no data loss", () => {
  /** Install profile A and seed one page per directory (including the new dir). */
  async function setupNonDefaultProject(): Promise<void> {
    await mkdir(path.join(root, ".llmwiki"), { recursive: true });
    await writeFile(path.join(root, PROFILE_FILE), `${JSON.stringify(PROFILE_A, null, 2)}\n`, "utf8");
    await writePage("wiki/papers", "scaling-laws");
    await writePage("wiki/ideas", "sparse-routing");
    await writePage("wiki/legacy-notes", "old-meeting");
    await writePage("wiki/experiments", "ablation-batch-size");
  }

  it("classifies dispositions and leaves profile.json + wiki tree byte-identical", async () => {
    await setupNonDefaultProject();
    const candidate = path.join(root, "candidate-b.json");
    await writeFile(candidate, JSON.stringify(PROFILE_B), "utf8");

    const before = await snapshotTree(root);
    const result = await runCLI(["profile", "diff", "--candidate", candidate], root);
    const after = await snapshotTree(root);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/needs-migration\twiki\/ideas\/sparse-routing/);
    expect(result.stdout).toMatch(/deprecated\twiki\/legacy-notes\/old-meeting/);
    expect(result.stdout).toMatch(/newly-supported\twiki\/experiments\/ablation-batch-size/);
    expect(after).toEqual(before);
    expect(await readFile(path.join(root, PROFILE_FILE), "utf8")).toBe(`${JSON.stringify(PROFILE_A, null, 2)}\n`);
  });
});

describe("profile diff — invalid (symlinked) entity directory", () => {
  let outsideRoot = "";

  afterEach(async () => {
    if (outsideRoot) await rm(outsideRoot, { recursive: true, force: true });
    outsideRoot = "";
  });

  /** Install profile A but make `wiki/papers` a symlink (confinement failure). */
  async function setupSymlinkedEntityDir(): Promise<void> {
    await mkdir(path.join(root, ".llmwiki"), { recursive: true });
    await writeFile(path.join(root, PROFILE_FILE), `${JSON.stringify(PROFILE_A, null, 2)}\n`, "utf8");
    await writePage("wiki/ideas", "sparse-routing");
    await writePage("wiki/legacy-notes", "old-meeting");
    outsideRoot = await mkdtemp(path.join(os.tmpdir(), "profile-cli-outside-"));
    await mkdir(path.join(root, "wiki"), { recursive: true });
    await symlink(outsideRoot, path.join(root, "wiki/papers"));
  }

  it("surfaces the invalid directory, exits non-zero, and writes nothing", async () => {
    await setupSymlinkedEntityDir();
    const candidate = path.join(root, "candidate-b.json");
    await writeFile(candidate, JSON.stringify(PROFILE_B), "utf8");

    const before = await snapshotTree(path.join(root, "wiki/ideas"));
    const result = await runCLI(["profile", "diff", "--candidate", candidate], root);
    const after = await snapshotTree(path.join(root, "wiki/ideas"));

    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("no profile changes");
    expect(result.stdout + result.stderr).toMatch(/wiki\/papers.*invalid/);
    expect(after).toEqual(before);
  });
});

describe("profile diff — default project", () => {
  it("prints 'no profile changes' with no flags on a default project", async () => {
    await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
    const result = await runCLI(["profile", "diff"], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no profile changes");
  });
});
