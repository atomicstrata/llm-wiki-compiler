/**
 * @file test/profile-loader-confined.test.ts
 * @description TDD tests for the profile loader confinement hardening (Fix 2).
 *
 * `loadProfile` previously did a bare `readFile` that (a) followed symlinks on the
 * `.llmwiki` dir AND on the `profile.json` leaf, and (b) had no size cap before
 * `JSON.parse`. This file covers the three confinement gaps:
 *
 *   - A symlinked `profile.json` leaf (→ out-of-tree file) → fails closed.
 *   - A symlinked `.llmwiki` dir (→ out-of-tree dir) → fails closed.
 *   - An oversized `profile.json` → fails closed before parse.
 *   - A normal profile still loads correctly (regression).
 *   - An absent profile still yields the default (regression).
 *
 * Platform note: O_NOFOLLOW symlink rejection is a POSIX guarantee; on platforms
 * where `symlink` itself fails the test is skipped (matches the pattern used
 * elsewhere in the test suite for symlink-dependent tests).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PROFILE_FILE, LLMWIKI_DIR, MAX_PROFILE_BYTES } from "../src/utils/constants.js";
import { loadProfile, ProfileLoadError } from "../src/profile/load.js";
import { DEFAULT_PROFILE } from "../src/profile/default.js";

interface ConfineTempRoots { root: string; outside: string }

/** Create two temp dirs (root + outside) and return them. Caller is responsible for cleanup. */
async function makeConfineTempRoots(prefix: string): Promise<ConfineTempRoots> {
  return {
    root: await mkdtemp(path.join(os.tmpdir(), `${prefix}-`)),
    outside: await mkdtemp(path.join(os.tmpdir(), `${prefix}-outside-`)),
  };
}

/** Remove two temp roots, ignoring errors if already absent. */
async function cleanupConfineTempRoots(ctx: ConfineTempRoots): Promise<void> {
  await rm(ctx.root, { recursive: true, force: true });
  await rm(ctx.outside, { recursive: true, force: true });
}

let ctx: ConfineTempRoots = { root: "", outside: "" };

beforeEach(async () => { ctx = await makeConfineTempRoots("prof-confine"); });
afterEach(async () => { await cleanupConfineTempRoots(ctx); });

const profilePath = (): string => path.join(ctx.root, PROFILE_FILE);
const llmwikiDir = (): string => path.join(ctx.root, LLMWIKI_DIR);

/** A minimal valid profile JSON string (entities must have at least one entry). */
const VALID_JSON = JSON.stringify({
  schemaVersion: 1,
  profileId: "test",
  displayName: "Test",
  entities: { notes: { directory: "wiki/notes" } },
});

/** Write a real profile file under ctx.root. */
async function writeProfile(content: string): Promise<void> {
  await mkdir(path.dirname(profilePath()), { recursive: true });
  await writeFile(profilePath(), content, "utf8");
}

describe("profile loader leaf symlink (O_NOFOLLOW)", () => {
  it("fails closed when profile.json is a symlink to an out-of-tree file", async () => {
    const outsideFile = path.join(ctx.outside, "secret.json");
    await writeFile(outsideFile, VALID_JSON, "utf8");
    await mkdir(llmwikiDir(), { recursive: true });
    let symlinkCreated = true;
    try {
      await symlink(outsideFile, profilePath());
    } catch {
      symlinkCreated = false;
    }
    if (!symlinkCreated) return; // skip: platform cannot create symlinks
    await expect(loadProfile(ctx.root)).rejects.toBeInstanceOf(ProfileLoadError);
  });
});

describe("profile loader dir symlink (O_NOFOLLOW on .llmwiki)", () => {
  it("fails closed when .llmwiki is a symlink to an out-of-tree dir", async () => {
    // Plant a valid profile.json in the outside dir so the content read could succeed.
    await writeFile(path.join(ctx.outside, "profile.json"), VALID_JSON, "utf8");
    let symlinkCreated = true;
    try {
      await symlink(ctx.outside, llmwikiDir(), "dir");
    } catch {
      symlinkCreated = false;
    }
    if (!symlinkCreated) return; // skip: platform cannot create symlinks
    await expect(loadProfile(ctx.root)).rejects.toBeInstanceOf(ProfileLoadError);
  });
});

describe("profile loader size cap", () => {
  it("fails closed with ProfileLoadError when profile.json exceeds the size cap", async () => {
    // One byte over the cap must fail closed (boundary stays coupled to the constant).
    const oversized = "x".repeat(MAX_PROFILE_BYTES + 1);
    await writeProfile(oversized);
    await expect(loadProfile(ctx.root)).rejects.toBeInstanceOf(ProfileLoadError);
  });
});

describe("profile loader regression (parity)", () => {
  it("loads a normal profile correctly after confinement hardening", async () => {
    await writeProfile(VALID_JSON);
    const loaded = await loadProfile(ctx.root);
    expect(loaded.profile.profileId).toBe("test");
    expect(loaded.loadedFrom).toBe(profilePath());
  });

  it("absent profile still yields the built-in default", async () => {
    const loaded = await loadProfile(ctx.root);
    expect(loaded.profile).toBe(DEFAULT_PROFILE);
    expect(loaded.loadedFrom).toBeNull();
  });

  it("broken JSON still throws ProfileLoadError (fail-closed, not default)", async () => {
    await writeProfile("{ not valid json");
    await expect(loadProfile(ctx.root)).rejects.toBeInstanceOf(ProfileLoadError);
  });
});
