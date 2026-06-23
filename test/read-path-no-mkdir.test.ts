/**
 * @file test/read-path-no-mkdir.test.ts
 * @description Regression contract: read-only entry points must NOT create
 * `.llmwiki/` in a clean project (no prior `.llmwiki` dir present).
 *
 * Before the fix, `resolveConfinedPrivateDir` unconditionally `mkdir`-ed
 * `<root>/.llmwiki`. Two read-only callers invoked it:
 *   - `loadProfile` (called by status, lint, exportJson, many others)
 *   - `readHeadAnchor` inside `readEvents` (called by lint/status event checks)
 *
 * After the fix, each of these surfaces MUST leave a clean project dir-free.
 * This file pins every affected surface with a concrete assertion.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadProfile } from "../src/profile/load.js";
import { readEvents } from "../src/events/store-read.js";
import { collectStatus } from "../src/status/collect.js";
import { lint } from "../src/linter/index.js";
import { exportJson } from "../src/commands/export.js";
import { LLMWIKI_DIR, PROFILE_FILE } from "../src/utils/constants.js";
import { PrivateDirConfinementError } from "../src/utils/private-dir.js";
import { ProfileLoadError } from "../src/profile/load.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "read-no-mkdir-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const llmwikiDir = () => path.join(root, LLMWIKI_DIR);
const privateDirAbsent = () => !existsSync(llmwikiDir());

describe("loadProfile — no .llmwiki creation on clean project", () => {
  it("returns default profile without creating .llmwiki", async () => {
    const loaded = await loadProfile(root);
    expect(loaded.loadedFrom).toBeNull();
    expect(privateDirAbsent()).toBe(true);
  });

  it("loads a real profile correctly when .llmwiki already exists", async () => {
    const VALID_JSON = JSON.stringify({ schemaVersion: 1, profileId: "myprof", displayName: "My", entities: { n: { directory: "wiki/n" } } });
    await mkdir(llmwikiDir(), { recursive: true });
    await writeFile(path.join(root, PROFILE_FILE), VALID_JSON, "utf8");
    const loaded = await loadProfile(root);
    expect(loaded.profile.profileId).toBe("myprof");
  });
});

describe("readEvents — no .llmwiki creation on clean project", () => {
  it("returns empty events without creating .llmwiki", async () => {
    const result = await readEvents(root);
    expect(result.events).toHaveLength(0);
    expect(privateDirAbsent()).toBe(true);
  });
});

describe("collectStatus — no .llmwiki creation on clean project", () => {
  it("returns status without creating .llmwiki", async () => {
    const status = await collectStatus(root);
    expect(status.pages.total).toBe(0);
    expect(privateDirAbsent()).toBe(true);
  });
});

describe("lint — no .llmwiki creation on clean project", () => {
  it("runs lint without creating .llmwiki", async () => {
    // The PROGRAMMATIC lint() (src/linter/index.ts) does NOT write the lint cache —
    // only the CLI command (src/commands/lint.ts) calls writeLintCache. So lint()'s
    // sole touch of .llmwiki is the READ path (loadProfile / event checks), which
    // must not create the dir. A clean project therefore stays .llmwiki-free after
    // lint(), the same contract as the other read surfaces.
    const summary = await lint(root);
    expect(summary).toBeDefined();
    expect(privateDirAbsent()).toBe(true);
  });
});

describe("exportJson — no .llmwiki creation on clean project", () => {
  it("exports without creating .llmwiki", async () => {
    const doc = await exportJson(root);
    expect(doc).toBeDefined();
    expect(privateDirAbsent()).toBe(true);
  });
});

describe("symlinked .llmwiki still fails closed on the READ path", () => {
  it("loadProfile throws ProfileLoadError when .llmwiki is a symlink escaping root", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "read-no-mkdir-out-"));
    try {
      await symlink(outside, llmwikiDir(), "dir");
      await expect(loadProfile(root)).rejects.toBeInstanceOf(ProfileLoadError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("readEvents throws PrivateDirConfinementError when .llmwiki is a symlink escaping root", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "read-no-mkdir-out2-"));
    try {
      await symlink(outside, llmwikiDir(), "dir");
      await expect(readEvents(root)).rejects.toBeInstanceOf(PrivateDirConfinementError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
