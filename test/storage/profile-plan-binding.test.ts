/**
 * @file test/storage/profile-plan-binding.test.ts
 * @description The remaining profile-planning reads as ONE body each, with the
 * root forms delegating over per-call local defaults: the profile diff over the
 * shared entity scan's own binding (`diffProfilesFrom`), the remote pair and plan
 * sequencing (`resolveRemoteUpdatePairFrom`, `planRemoteTemplateUpdateWith`) with
 * tap resolution as a HOST step, and the builtin plan (`planBuiltinTemplateUpdateWith`).
 *
 * HOW IT IS BUILT. Memory doubles log every call to pin the union iteration, the
 * refusals and the order. The real entity scan, tap resolution and plan suites
 * (`profile-diff*`, `profile-template-remote-update`, `profile-template-update-plan`)
 * run alongside this file.
 */

import { describe, expect, it } from "bun:test";
import { diffProfilesFrom } from "../../src/profile/diff.js";
import { profileDigest } from "../../src/profile/digest.js";
import { getBuiltinTemplate, listBuiltinTemplates } from "../../src/profile/templates/registry.js";
import { planRemoteTemplateUpdateWith, resolveRemoteUpdatePairFrom, type RemotePlanSteps, type RemoteUpdatePair } from "../../src/profile/templates/remote-lifecycle.js";
import { planBuiltinTemplateUpdateWith, type BuiltinPlanSteps, type TemplateUpdatePlan, type TemplateUpdateReads } from "../../src/profile/templates/update.js";
import type { LegacyLocalEntityScans } from "../../src/storage/legacy-local-reads.js";
import type { ProfilePack } from "../../src/profile/types.js";

const unasked = async (): Promise<never> => { throw new Error("not asked"); };

describe("profile diff: one body over the entity scans", () => {
  it("D1 walks the union of directories old-first, reports an invalid directory under its owner, and sorts, tallies and digests", async () => {
    const log: string[] = [];
    const scans: LegacyLocalEntityScans = {
      openEntityDirectory: async (dir) => {
        log.push(`open ${dir}`);
        if (dir === "wiki/b") return { status: "invalid" };
        return { status: "ok", directory: {
          listNames: async () => ["z.md", "Bad Name.md", "note.txt", "a.md"],
          resolveEntry: async (name) => `${dir}/${name}`,
          readPrefix: unasked,
          readText: async () => "---\ntitle: T\n---\nbody\n",
        } };
      },
    };
    const oldProfile = { schemaVersion: 1, profileId: "p", entities: { alpha: { directory: "wiki/a" } } } as unknown as ProfilePack;
    const newProfile = { schemaVersion: 1, profileId: "p", entities: { beta: { directory: "wiki/b" }, alpha: { directory: "wiki/a" } } } as unknown as ProfilePack;
    const report = await diffProfilesFrom(scans, oldProfile, newProfile);
    expect(log).toEqual(["open wiki/a", "open wiki/b"]);
    expect(report.pages.map((page) => `${page.stem}:${page.disposition}`)).toEqual(["a:unchanged", "Bad Name:blocked", "z:unchanged"]);
    expect([report.problems.map((problem) => problem.entityType), report.counts.unchanged, report.counts.blocked]).toEqual([["beta"], 2, 1]);
    expect([report.oldDigest, report.newDigest, report.unchanged]).toEqual([profileDigest(oldProfile), profileDigest(newProfile), false]);
  });
});

const PAIR = { base: { package: "BASE" }, candidate: { package: "CANDIDATE" }, fromCoordinate: "from", toCoordinate: "to" } as unknown as RemoteUpdatePair;
const PLAN = { compatible: true, reasons: [] } as unknown as TemplateUpdatePlan;

/** Memory remote-plan steps; every step is logged. */
function remote(log: string[], lock: Awaited<ReturnType<RemotePlanSteps["readTemplateLock"]>>): RemotePlanSteps {
  return {
    readTemplateLock: async () => { log.push("lock"); return lock; },
    resolvePairFromLock: async (_lock, toVersion, offline) => { log.push(`resolve ${toVersion} ${offline}`); return PAIR; },
    loadProfile: async () => { log.push("profile"); return { profile: "ACTIVE" } as never; },
    planUpdate: async (active, base, candidate) => { log.push(`plan ${String(active)} ${String(base)} ${String(candidate)}`); return PLAN; },
  };
}
const REMOTE_LOCK = { kind: "ok", lock: { schemaVersion: 2, sourceType: "remote" } } as never;

describe("remote planning: the project sequencing over host pair resolution", () => {
  it("R1 refuses anything but a current v2 remote lock before resolving, and passes the offline flag through", async () => {
    const log: string[] = [];
    await expect(resolveRemoteUpdatePairFrom(remote(log, { kind: "absent" }), "1.1.0", true)).rejects.toThrow("remote update provenance is absent");
    await expect(resolveRemoteUpdatePairFrom(remote(log, { kind: "ok", lock: { schemaVersion: 2, sourceType: "builtin" } } as never), "1.1.0", true))
      .rejects.toThrow("remote update provenance is ok");
    expect(log).toEqual(["lock", "lock"]);
    expect(await resolveRemoteUpdatePairFrom(remote(log, REMOTE_LOCK), "1.1.0", true)).toBe(PAIR);
    expect(log.at(-1)).toBe("resolve 1.1.0 true");
  });

  it("R2 plans online: pair, then the active profile, then the plan over the pair's packages, with the coordinates merged", async () => {
    const log: string[] = [];
    expect(await planRemoteTemplateUpdateWith(remote(log, REMOTE_LOCK), "1.1.0")).toEqual({ ...PLAN, fromCoordinate: "from", toCoordinate: "to" });
    expect(log).toEqual(["lock", "resolve 1.1.0 false", "profile", "plan ACTIVE BASE CANDIDATE"]);
  });
});

/** Memory plan reads over an empty project; every look is logged. */
function planReads(log: string[]): TemplateUpdateReads {
  return {
    diff: async () => { log.push("diff"); return { problems: [], pages: [] } as never; },
    lintEntities: async () => { log.push("lint"); return []; },
    entries: async () => { log.push("entries"); return "absent"; },
    firstFileUnder: unasked,
    auditCandidateArchive: async () => { log.push("archive"); return []; },
    auditWorkflowHistory: async () => { log.push("workflow"); return []; },
    auditArtifactStore: async () => { log.push("artifacts"); return []; },
  };
}

describe("builtin planning: one body", () => {
  // The first INSTALLABLE builtin: the `default` summary is listed but deliberately not installable.
  const latest = listBuiltinTemplates().map((summary) => getBuiltinTemplate(summary.templateId)).find((template) => template !== undefined)!;
  const lock = { schemaVersion: 2, sourceType: "builtin", templateId: latest.templateId, version: latest.version, publisher: latest.publisher };
  const steps = (log: string[], read: Awaited<ReturnType<BuiltinPlanSteps["readTemplateLock"]>>): BuiltinPlanSteps => ({
    readTemplateLock: async () => { log.push("lock"); return read; },
    loadProfile: async () => { log.push("profile"); return { profile: latest.profile } as never; },
    plan: planReads(log),
  });

  it("B1 refuses missing provenance, a non-builtin source, an unresolvable release and an identity change before loading the profile", async () => {
    const log: string[] = [];
    await expect(planBuiltinTemplateUpdateWith(steps(log, { kind: "absent" }))).rejects.toThrow("template provenance is absent");
    await expect(planBuiltinTemplateUpdateWith(steps(log, { kind: "ok", lock: { ...lock, sourceType: "local" } } as never))).rejects.toThrow("builtin installs only");
    await expect(planBuiltinTemplateUpdateWith(steps(log, { kind: "ok", lock: { ...lock, version: "0.0.0-none" } } as never))).rejects.toThrow("cannot independently resolve installed builtin");
    await expect(planBuiltinTemplateUpdateWith(steps(log, { kind: "ok", lock } as never), "other")).rejects.toThrow("cannot change template identity");
    expect(log).toEqual(["lock", "lock", "lock", "lock"]);
  });

  it("B2 resolves both releases from the registry, then loads the profile and runs the plan body in order", async () => {
    const log: string[] = [];
    const plan = await planBuiltinTemplateUpdateWith(steps(log, { kind: "ok", lock } as never));
    expect([plan.compatible, log]).toEqual([true, ["lock", "profile", "diff", "lint", "entries", "archive", "workflow", "artifacts"]]);
  });
});
