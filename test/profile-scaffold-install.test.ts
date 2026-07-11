/**
 * @file test/profile-scaffold-install.test.ts
 * @description Tests safe, locked installation of beginner profile scaffolds.
 */

import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProfile } from "../src/profile/load.js";
import {
  canonicalStarterProfileJson,
  installStarterProfile,
} from "../src/profile/scaffold.js";
import { PROFILE_FILE } from "../src/utils/constants.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { expectProfileAbsent, managedTempRoots } from "./fixtures/managed-temp-roots.js";

const roots = managedTempRoots();

async function expectLockReleased(root: string): Promise<void> {
  const acquired = await acquireLock(root, { quiet: true });
  expect(acquired).toBe(true);
  if (acquired) await releaseLock(root);
}

afterEach(roots.cleanup);

describe("installStarterProfile", () => {
  it("installs the exact starter profile and entity directory", async () => {
    const root = await roots.create("profile-scaffold-install");

    const result = await installStarterProfile(root, "issue-tracker", "issues");

    expect(result).toEqual({ profileId: "issue-tracker", entityType: "issues", directory: "wiki/issues" });
    expect(await readFile(path.join(root, PROFILE_FILE), "utf8"))
      .toBe(canonicalStarterProfileJson("issue-tracker", "issues"));
    expect((await loadProfile(root)).profile.profileId).toBe("issue-tracker");
  });

  it("refuses an existing profile without changing it", async () => {
    const root = await roots.create("profile-scaffold-existing");
    await installStarterProfile(root, "first-profile", "tickets");
    const before = await readFile(path.join(root, PROFILE_FILE), "utf8");

    await expect(installStarterProfile(root, "second-profile", "issues"))
      .rejects.toThrow(/profile already exists/i);
    expect(await readFile(path.join(root, PROFILE_FILE), "utf8")).toBe(before);
  });

  it("refuses a populated default wiki", async () => {
    const root = await roots.create("profile-scaffold-default-content");
    await writeFile(path.join(root, "wiki/concepts/existing.md"), "# Existing\n", "utf8");

    await expect(installStarterProfile(root, "issue-tracker", "issues"))
      .rejects.toThrow(/typed corpus is not empty.*wiki\/concepts/is);
    await expectProfileAbsent(root);
  });

  it("refuses existing typed stores", async () => {
    const root = await roots.create("profile-scaffold-stores");
    await mkdir(path.join(root, "artifacts/example"), { recursive: true });
    await writeFile(path.join(root, "artifacts/example/result.txt"), "result", "utf8");

    await expect(installStarterProfile(root, "issue-tracker", "issues"))
      .rejects.toThrow(/typed corpus is not empty/i);
  });

  it("removes only its empty directory when the profile write fails", async () => {
    const root = await roots.create("profile-scaffold-compensate");
    const failWrite = async (): Promise<void> => { throw new Error("injected write failure"); };

    await expect(installStarterProfile(root, "issue-tracker", "issues", { writeProfile: failWrite }))
      .rejects.toThrow(/injected write failure/);
    await expectProfileAbsent(root);
    await expect(stat(path.join(root, "wiki/issues"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never removes a pre-existing entity directory after failure", async () => {
    const root = await roots.create("profile-scaffold-preserve-dir");
    await mkdir(path.join(root, "wiki/issues"), { recursive: true });
    const failWrite = async (): Promise<void> => { throw new Error("injected write failure"); };

    await expect(installStarterProfile(root, "issue-tracker", "issues", { writeProfile: failWrite }))
      .rejects.toThrow(/injected write failure/);
    expect((await stat(path.join(root, "wiki/issues"))).isDirectory()).toBe(true);
    await writeFile(path.join(root, "wiki/issues/still-usable.txt"), "yes", "utf8");
    expect(await readFile(path.join(root, "wiki/issues/still-usable.txt"), "utf8")).toBe("yes");
  });

  it("preserves a committed profile and directory after a late durability error", async () => {
    const root = await roots.create("profile-scaffold-late-error");
    const lateError = async (projectRoot: string, body: string): Promise<void> => {
      await mkdir(path.join(projectRoot, ".llmwiki"), { recursive: true });
      await writeFile(path.join(projectRoot, PROFILE_FILE), body, "utf8");
      throw new Error("injected sync failure");
    };

    await expect(installStarterProfile(root, "issue-tracker", "issues", { writeProfile: lateError }))
      .rejects.toThrow(/profile was installed.*durability confirmation failed/i);
    expect((await stat(path.join(root, "wiki/issues"))).isDirectory()).toBe(true);
    expect(await readFile(path.join(root, PROFILE_FILE), "utf8"))
      .toBe(canonicalStarterProfileJson("issue-tracker", "issues"));
    await expectLockReleased(root);
  });

  it("serializes concurrent scaffold attempts under the project lock", async () => {
    const root = await roots.create("profile-scaffold-concurrent");
    let releaseWriter: () => void = () => undefined;
    const writerMayFinish = new Promise<void>((resolve) => { releaseWriter = resolve; });
    let reportWriterStarted: () => void = () => undefined;
    const writerStarted = new Promise<void>((resolve) => { reportWriterStarted = resolve; });
    const pausedWrite = async (projectRoot: string, body: string): Promise<void> => {
      reportWriterStarted();
      await writerMayFinish;
      await mkdir(path.join(projectRoot, ".llmwiki"), { recursive: true });
      await writeFile(path.join(projectRoot, PROFILE_FILE), body, "utf8");
    };

    const first = installStarterProfile(root, "issue-tracker", "issues", { writeProfile: pausedWrite });
    await writerStarted;
    const second = installStarterProfile(root, "other-profile", "tickets");
    releaseWriter();

    await expect(first).resolves.toMatchObject({ profileId: "issue-tracker" });
    await expect(second).rejects.toThrow(/profile already exists/i);
  });

  it("fails closed for a symlinked entity directory", async () => {
    const root = await roots.create("profile-scaffold-symlink");
    const outside = await roots.create("profile-scaffold-outside");
    await symlink(outside, path.join(root, "wiki/issues"));

    await expect(installStarterProfile(root, "issue-tracker", "issues"))
      .rejects.toThrow(/unsafe|symlink|escapes/i);
    await expectProfileAbsent(root);
  });
});
