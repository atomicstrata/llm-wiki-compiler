/**
 * @file test/storage/profile-install-binding.test.ts
 * @description Profile installation as ONE body per step over its own project
 * reads and steps, with every root form delegating over per-call local defaults:
 * the advisory lock reader (`readTemplateLockFrom`), the typed-corpus probe
 * (`isTypedCorpusEmptyFrom`), the starter-profile scaffold's locked region
 * (`installStarterProfileLockedWith`) and the template install's locked region
 * (`installPackageLockedWith`).
 *
 * HOW IT IS BUILT. Memory doubles log every call to pin order, refusals and the
 * failed-write classification. One real-disk case shows the scaffold root form
 * reads each test dependency only when it is used, after the entity directory
 * exists, and hands it this root. Confinement, no-follow reads and durable writes
 * stay with the local defaults and the existing scaffold, template and lock
 * suites, which run alongside this file.
 */

import { access } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { ProfileScaffoldError, buildStarterProfile, installStarterProfile, installStarterProfileLockedWith, type StarterProfileInstallSteps } from "../../src/profile/scaffold.js";
import { isTypedCorpusEmptyFrom, type TypedCorpusReads } from "../../src/profile/templates/corpus.js";
import { installPackageLockedWith, type TemplateInstallSteps } from "../../src/profile/templates/install.js";
import { readTemplateLockFrom } from "../../src/profile/templates/lock.js";
import type { LoadedProfile, ProfilePack } from "../../src/profile/types.js";
import type { ProfileTemplatePackage } from "../../src/profile/templates/types.js";
import { tempRootTracker } from "../temp-roots.js";

const tracker = tempRootTracker();
afterAll(() => tracker.cleanup());

const DEFAULT_LOADED = { profile: { schemaVersion: 1, profileId: "default", entities: {} }, loadedFrom: null } as unknown as LoadedProfile;
const EXISTING = { ...DEFAULT_LOADED, loadedFrom: "/p/.llmwiki/profile.json" } as unknown as LoadedProfile;
const unasked = async (): Promise<never> => { throw new Error("not asked"); };
const AT = "2026-01-01T00:00:00.000Z";

/** A memory corpus where every store is empty unless `over` says otherwise; every look is logged. */
function corpus(log: string[], over: Partial<TypedCorpusReads> = {}): TypedCorpusReads {
  return {
    entries: async (dir) => { log.push(`entries ${dir}`); return "absent"; },
    firstFileUnder: async (dir) => { log.push(`first ${dir}`); return "absent"; },
    relations: { readStore: async () => { log.push("relations"); return null; } },
    events: { graph: { readStore: async () => { log.push("events"); return null; } }, resolvePrivateDir: async () => null, readHeadLeaf: unasked },
    workflowRuns: { resolvePrivateDir: async () => { log.push("workflow"); return null; }, resolveRunsDir: unasked, listRunNames: unasked, readRunLeaf: unasked, loadIntegrity: unasked },
    ...over,
  };
}

describe("template lock reader: one body over the private-directory and leaf looks", () => {
  it("K1 keeps unsafe, absent, unreadable, malformed and ok distinct, and reads no leaf without a directory", async () => {
    const log: string[] = [];
    const reads = (dir: () => Promise<string | null>, leaf: Awaited<ReturnType<Parameters<typeof readTemplateLockFrom>[0]["readLockLeaf"]>>) => ({
      resolvePrivateDir: dir, readLockLeaf: async (d: string, max: number) => { log.push(`leaf ${d} ${max}`); return leaf; },
    });
    expect(await readTemplateLockFrom(reads(async () => { throw new Error("escape"); }, { kind: "absent" }))).toEqual({ kind: "unavailable", detail: "private directory is unsafe" });
    expect(await readTemplateLockFrom(reads(async () => null, { kind: "absent" }))).toEqual({ kind: "absent" });
    expect(log).toEqual([]);
    expect(await readTemplateLockFrom(reads(async () => "D", { kind: "absent" }))).toEqual({ kind: "absent" });
    expect(await readTemplateLockFrom(reads(async () => "D", { kind: "unavailable" } as never))).toEqual({ kind: "unavailable", detail: "lock leaf is unreadable or unsafe" });
    expect(await readTemplateLockFrom(reads(async () => "D", { kind: "ok", body: "{" } as never))).toEqual({ kind: "malformed", detail: "lock is not valid JSON" });
    const valid = { schemaVersion: 2, templateId: "team", version: "1.0.0", publisher: "local", sourceType: "builtin", installedAt: AT, profileDigest: "a".repeat(64) };
    expect(await readTemplateLockFrom(reads(async () => "D", { kind: "ok", body: JSON.stringify(valid) }))).toEqual({ kind: "ok", lock: valid });
    expect(log).toEqual(["leaf D 65536", "leaf D 65536", "leaf D 65536", "leaf D 65536"]);
  });
});

describe("typed-corpus probe: one body in the incumbent order", () => {
  it("C1 asks each store once in order, de-duplicating entity directories in insertion order, with the exact reasons", async () => {
    const log: string[] = [];
    const target = { ...DEFAULT_LOADED.profile, entities: { notes: { directory: "wiki/notes" }, ideas: { directory: "wiki/ideas" } } } as unknown as ProfilePack;
    const loaded = { ...DEFAULT_LOADED, profile: { ...DEFAULT_LOADED.profile, entities: { ideas: { directory: "wiki/ideas" } } } } as unknown as LoadedProfile;
    const reads = corpus(log, {
      entries: async (dir) => { log.push(`entries ${dir}`); return dir === "wiki/notes" ? ["a.md"] : dir.endsWith("archive") ? "unavailable" : ["x.json"]; },
      firstFileUnder: async (dir) => { log.push(`first ${dir}`); return "present"; },
      relations: { readStore: async () => { log.push("relations"); throw new Error("sick"); } },
    });
    const probe = await isTypedCorpusEmptyFrom(reads, loaded, target);
    expect(log).toEqual(["entries wiki/ideas", "entries wiki/notes", "relations", "first artifacts", "workflow",
      "entries .llmwiki/candidates", "entries .llmwiki/candidates/archive", "events"]);
    expect(probe).toEqual({ empty: false, reasons: [
      "typed entity pages exist under wiki/notes", "relation store is unreadable or unsafe", "artifact store contains files",
      "pending review candidates exist", "candidate archive is unreadable or unsafe",
    ] });
  });
});

/** Memory scaffold steps over an empty corpus; `write` and `commit` script the failure. */
function scaffold(log: string[], script: { loaded?: LoadedProfile; created?: boolean; write?: Error; commit?: "committed" | "absent" | "unknown"; cleanup?: Error } = {}): StarterProfileInstallSteps {
  return {
    loadProfile: async () => { log.push("load"); return script.loaded ?? DEFAULT_LOADED; },
    corpus: corpus([]),
    prepareEntityDirectory: async (dir) => { log.push(`prepare ${dir}`); return script.created ?? true; },
    writeProfile: async () => { log.push("write"); if (script.write) throw script.write; },
    confirmProfileCommit: async () => { log.push("confirm"); return script.commit ?? "absent"; },
    entityDirectoryHandle: (dir) => `H/${dir}`,
    removeEmptyDirectory: async (handle) => { log.push(`rmdir ${handle}`); if (script.cleanup) throw script.cleanup; },
  };
}
const REQUEST = { profile: buildStarterProfile("team", "notes"), profileId: "team", entityType: "notes", directory: "wiki/notes" };

describe("starter-profile scaffold: one locked body", () => {
  it("S1 refuses an existing profile before the probe, then prepares, serializes and writes", async () => {
    const log: string[] = [];
    await expect(installStarterProfileLockedWith(scaffold(log, { loaded: EXISTING }), REQUEST)).rejects.toThrow("A profile already exists.");
    expect(log).toEqual(["load"]);
    log.length = 0;
    expect(await installStarterProfileLockedWith(scaffold(log), REQUEST)).toEqual({ profileId: "team", entityType: "notes", directory: "wiki/notes" });
    expect(log).toEqual(["load", "prepare wiki/notes", "write"]);
  });

  it("S2 classifies a failed write: installed, unknown with no cleanup, absent removing only a created directory and rethrowing the original", async () => {
    const original = new Error("disk full");
    const run = async (script: Parameters<typeof scaffold>[1]) => {
      const log: string[] = [];
      const error = await installStarterProfileLockedWith(scaffold(log, { write: original, ...script }), REQUEST).catch((e: unknown) => e);
      return [error, log.filter((entry) => entry === "confirm" || entry.startsWith("rmdir"))];
    };
    const [installed] = await run({ commit: "committed" });
    expect([(installed as ProfileScaffoldError).outcome, (installed as Error).message]).toEqual(["installed", "Profile was installed, but durability confirmation failed: disk full"]);
    const [unknown, unknownLog] = await run({ commit: "unknown" });
    expect([(unknown as ProfileScaffoldError).outcome, unknownLog]).toEqual(["unknown", ["confirm"]]);
    expect(await run({ commit: "absent" })).toEqual([original, ["confirm", "rmdir H/wiki/notes"]]);
    const [kept, keptLog] = await run({ commit: "absent", created: false });
    expect([kept instanceof ProfileScaffoldError, (kept as Error).message, keptLog]).toEqual([true, "disk full", ["confirm"]]);
    const [stuck] = await run({ commit: "absent", cleanup: new Error("ENOTEMPTY") });
    expect((stuck as Error).message).toBe("disk full; cleanup failed for H/wiki/notes: ENOTEMPTY");
  });

  it("S3 the root form reads each dependency only when used, after the directory exists, and hands it this root", async () => {
    const root = await tracker.create("profile-install-binding-");
    const reads: string[] = [];
    const dependencies = {
      get writeProfile() {
        reads.push("writeProfile");
        return async (at: string) => { await access(path.join(at, "wiki", "notes")); reads.push(`write at ${at === root}`); throw new Error("injected"); };
      },
      get confirmProfileCommit() { reads.push("confirmProfileCommit"); return async () => "unknown" as const; },
    };
    await expect(installStarterProfile(root, "team", "notes", dependencies)).rejects.toMatchObject({ outcome: "unknown" });
    expect(reads).toEqual(["writeProfile", "write at true", "confirmProfileCommit"]);
  });
});

describe("template install: one locked body", () => {
  const pkg = { templateId: "team", version: "1.0.0", publisher: "local", profile: buildStarterProfile("team", "notes") } as unknown as ProfileTemplatePackage;
  function install(log: string[], over: Partial<TemplateInstallSteps> = {}): TemplateInstallSteps {
    return {
      loadProfile: async () => { log.push("load"); return DEFAULT_LOADED; },
      corpus: corpus([]),
      writeProfile: async (body) => { log.push(`profile ${body.endsWith("}\n")}`); },
      writeTemplateLock: async (lock) => { log.push(`lock ${lock.templateId} ${lock.profileDigest.length}`); },
      ...over,
    };
  }

  it("I1 refuses an existing profile without --force before the probe; installs the profile then the advisory lock", async () => {
    const log: string[] = [];
    await expect(installPackageLockedWith(install(log, { loadProfile: async () => { log.push("load"); return EXISTING; } }), pkg, { force: false, sourceType: "local" }))
      .rejects.toThrow("A profile already exists. Re-run with --force");
    expect(log).toEqual(["load"]);
    log.length = 0;
    expect(await installPackageLockedWith(install(log), pkg, { force: false, sourceType: "builtin" })).toEqual({ kind: "installed", templateId: "team", version: "1.0.0", lockWritten: true });
    expect(log).toEqual(["load", "profile true", "lock team 64"]);
  });

  it("I2 a failed advisory lock reports lockWritten false without rollback; an oversize profile is refused before any write", async () => {
    const log: string[] = [];
    const failingLock = install(log, { writeTemplateLock: async () => { log.push("lock"); throw new Error("EACCES"); } });
    expect((await installPackageLockedWith(failingLock, pkg, { force: false, sourceType: "builtin" })).lockWritten).toBe(false);
    expect(log).toEqual(["load", "profile true", "lock"]);
    log.length = 0;
    const huge = { ...pkg, profile: { ...pkg.profile, displayName: "x".repeat(2 * 1024 * 1024) } } as ProfileTemplatePackage;
    await expect(installPackageLockedWith(install(log), huge, { force: true, sourceType: "builtin" })).rejects.toThrow("byte profile cap");
    expect(log).toEqual(["load"]);
  });
});
