/**
 * @file test/storage/profile-update-binding.test.ts
 * @description The profile-update journey as ONE body per step over its own
 * reads and steps, with every root form delegating over per-call local defaults:
 * the history audits (`auditCandidateArchiveFrom`, `auditWorkflowHistoryFrom`),
 * the artifact-store audit (`auditArtifactStoreFrom`), the compatibility plan
 * (`planTemplateUpdateFrom`) and the locked remote update with its journalled
 * transaction (`applyRemoteUpdateLockedWith`).
 *
 * HOW IT IS BUILT. Memory doubles log every call to pin order, caps, refusals
 * and the transaction's failure handling. Remote tap resolution is a host step
 * double here; the incumbent disk behaviour, the remote fixture journey and the
 * recovery gate stay with the existing template update, plan and remote suites,
 * which run alongside this file.
 */

import { describe, expect, it } from "bun:test";
import { auditArtifactStoreFrom, type ArtifactAuditReads } from "../../src/profile/templates/artifact-audit.js";
import { auditCandidateArchiveFrom, auditWorkflowHistoryFrom, type HistoryAuditReads } from "../../src/profile/templates/history-audit.js";
import { planTemplateUpdateFrom, type TemplateUpdatePlan, type TemplateUpdateReads } from "../../src/profile/templates/update.js";
import { applyRemoteUpdateLockedWith, type RemoteUpdateLockedSteps } from "../../src/profile/templates/update-apply.js";
import type { RemoteUpdatePair } from "../../src/profile/templates/remote-lifecycle.js";
import type { ProfileTemplatePackage } from "../../src/profile/templates/types.js";
import type { ProfilePack } from "../../src/profile/types.js";
import { buildStarterProfile } from "../../src/profile/scaffold.js";

const unasked = async (): Promise<never> => { throw new Error("not asked"); };
const PROFILE = buildStarterProfile("team", "notes");

/** Memory history reads over an archive listing and a workflow-runs listing; every look is logged. */
function history(log: string[], archive: Array<{ name: string; isFile: boolean }> | null, bodies: Record<string, string>, runs: string[] | "absent" | "unavailable" = "absent"): HistoryAuditReads {
  return {
    resolveArchiveDir: async () => { log.push("archive-dir"); return archive === null ? null : "A"; },
    listArchive: async () => { log.push("list"); return archive ?? []; },
    readArchivedCandidate: async (name, max) => { log.push(`read ${name} ${max}`); return name in bodies ? { kind: "ok", body: bodies[name]! } : { kind: "unavailable" }; },
    workflowRunEntries: async () => { log.push("runs"); return runs; },
    workflowRuns: { resolvePrivateDir: unasked, resolveRunsDir: unasked, listRunNames: unasked, readRunLeaf: unasked, loadIntegrity: unasked },
  };
}

describe("history audits: one body each over the archive and workflow reads", () => {
  it("H1 refuses an unsafe or unlistable archive, caps the listing before any read, and audits each entry in listing order", async () => {
    const log: string[] = [];
    const unsafe = { ...history(log, null, {}), resolveArchiveDir: async () => { throw new Error("escape"); } };
    expect(await auditCandidateArchiveFrom(unsafe)).toEqual(["candidate archive is unreadable or unsafe"]);
    expect(await auditCandidateArchiveFrom(history(log, null, {}))).toEqual([]);
    const huge = Array.from({ length: 10_001 }, (_, i) => ({ name: `c${i}.json`, isFile: true }));
    log.length = 0;
    expect(await auditCandidateArchiveFrom(history(log, huge, {}))).toEqual(["candidate archive exceeds its entry cap"]);
    expect(log).toEqual(["archive-dir", "list"]);
    const good = JSON.stringify({ id: "ok", title: "t", slug: "s", body: "b", sources: [] });
    const entries = [{ name: "sub", isFile: false }, { name: "gone.json", isFile: true }, { name: "bad.json", isFile: true }, { name: "ok.json", isFile: true }];
    expect(await auditCandidateArchiveFrom(history([], entries, { "bad.json": "{\"id\":\"bad\"}", "ok.json": good }))).toEqual([
      "candidate archive contains unexpected entry: sub", "archived candidate is unreadable or unsafe: gone.json", "archived candidate is malformed: bad.json",
    ]);
  });

  it("H2 keeps the workflow listing's absent, unavailable and cap refusals, and refuses a non-JSON entry and an invalid run id without reading", async () => {
    expect(await auditWorkflowHistoryFrom(history([], null, {}, "absent"))).toEqual([]);
    const store = [{ kind: "store", message: "workflow store is unreadable, unsafe, or over its entry cap" }];
    expect(await auditWorkflowHistoryFrom(history([], null, {}, "unavailable"))).toEqual(store);
    expect(await auditWorkflowHistoryFrom(history([], null, {}, Array.from({ length: 10_001 }, (_, i) => `r${i}.json`)))).toEqual(store);
    expect(await auditWorkflowHistoryFrom(history([], null, {}, ["notes.txt", "BAD!.json"]))).toEqual([
      { kind: "store", message: "workflow store contains unexpected entry: notes.txt" }, { kind: "store", message: "workflow run BAD! is unavailable" },
    ]);
  });
});

describe("artifact-store audit: one body over the listings, the manifest and the resolver's reads", () => {
  it("A1 refuses undeclared types, unsafe slugs and unexpected legacy files, and reads the manifest only after the listing check", async () => {
    const log: string[] = [];
    const tree: Record<string, string[]> = { artifacts: ["result", "Nope"], "artifacts/result": ["a", "B!"], "artifacts/result/a": ["result.json", "result.json.manifest.json"] };
    const reads: ArtifactAuditReads = {
      entries: async (dir) => { log.push(`entries ${dir}`); return tree[dir] ?? "absent"; },
      readManifest: async (type, slug, file) => { log.push(`manifest ${type}/${slug}/${file}`); return { kind: "malformed" }; },
      store: { artifactAt: () => { throw new Error("not asked"); } },
    };
    const profile = { ...PROFILE, artifacts: { result: { fileName: "result.json", contentKind: "json", maxBytes: 1024, metadata: {} } } } as unknown as ProfilePack;
    expect(await auditArtifactStoreFrom(reads, profile)).toEqual([
      "artifact manifest is malformed: result/a", "artifact store contains unsafe slug \"B!\"", "artifact store contains undeclared type \"Nope\"",
    ]);
    expect(log).toEqual(["entries artifacts", "entries artifacts/result", "entries artifacts/result/a", "manifest result/a/result.json"]);
    tree["artifacts/result/a"] = ["result.json", "stray"];
    expect(await auditArtifactStoreFrom(reads, profile)).toContain("artifact directory contains unexpected files: artifacts/result/a");
  });
});

const pkg = (version: string, profile: ProfilePack = PROFILE) =>
  ({ templateId: "team", publisher: "atomicstrata", sourceType: "remote", version, profile }) as unknown as ProfileTemplatePackage;

/** Memory plan reads; every look is logged. */
function planReads(log: string[], over: Partial<TemplateUpdateReads> = {}): TemplateUpdateReads {
  return {
    diff: async () => { log.push("diff"); return { problems: [], pages: [] } as never; },
    lintEntities: async () => { log.push("lint"); return []; },
    entries: async (dir) => { log.push(`entries ${dir}`); return "absent"; },
    firstFileUnder: async (dir) => { log.push(`first ${dir}`); return "absent"; },
    auditCandidateArchive: async () => { log.push("archive"); return []; },
    auditWorkflowHistory: async () => { log.push("workflow"); return []; },
    auditArtifactStore: async () => { log.push("artifacts"); return []; },
    ...over,
  };
}

describe("update plan: one body, identity before any read", () => {
  it("U1 refuses an identity change before reading; otherwise reads in the incumbent order and maps lint and pending candidates", async () => {
    const log: string[] = [];
    await expect(planTemplateUpdateFrom(planReads(log), PROFILE, pkg("1.0.0"), { ...pkg("1.1.0"), templateId: "other" })).rejects.toThrow("cannot change template identity");
    expect(log).toEqual([]);
    const plan = await planTemplateUpdateFrom(planReads(log, {
      lintEntities: async () => { log.push("lint"); throw new Error("lint down"); },
      entries: async (dir) => { log.push(`entries ${dir}`); return ["c1.json"]; },
    }), PROFILE, pkg("1.0.0"), pkg("1.1.0"));
    expect(log).toEqual(["diff", "lint", "entries .llmwiki/candidates", "workflow", "artifacts"]);
    expect(plan.reasons).toEqual([
      { kind: "store", message: "candidate-profile validation is unavailable: lint down" },
      { kind: "candidate", message: "pending review candidates must be resolved before update" },
    ]);
  });
});

const resolved = (version: string, digest: string) => ({
  coordinate: `official/atomicstrata/team@${version}`, payloadDigest: `sha256:${digest.repeat(64)}`, publisherKeyId: "k", tapSequence: 1, package: pkg(version),
});
const PAIR = { base: resolved("1.0.0", "a"), candidate: resolved("1.1.0", "b"), fromCoordinate: "official/atomicstrata/team@1.0.0", toCoordinate: "official/atomicstrata/team@1.1.0" } as unknown as RemoteUpdatePair;
const COMPATIBLE = { compatible: true, reasons: [] } as unknown as TemplateUpdatePlan;

/** Memory locked-update steps; every step is logged. */
function updateSteps(log: string[], over: Partial<RemoteUpdateLockedSteps> = {}): RemoteUpdateLockedSteps {
  return {
    readTemplateLock: async () => { log.push("lock"); return { kind: "ok", lock: { schemaVersion: 2, sourceType: "remote" } } as never; },
    resolvePairFromLock: async () => { log.push("resolve"); return PAIR; },
    loadProfile: async () => { log.push("profile"); return { profile: PROFILE } as never; },
    planUpdate: async () => { log.push("plan"); return COMPATIBLE; },
    recoverJournal: async () => { log.push("recover"); return { status: "clean" }; },
    openBatch: async () => { log.push("open"); return {} as never; },
    recordPreState: async (_b, leaf) => { log.push(`pre ${leaf}`); },
    writeTemplateLock: async (lock) => { log.push(`write-lock ${lock.sourceType}`); },
    writeProfile: async () => { log.push("write-profile"); },
    commitBatch: async () => { log.push("commit"); },
    ...over,
  };
}

describe("locked remote update: one body and one journalled transaction", () => {
  it("R1 verifies provenance and evidence, plans fresh, then records both pre-states before writing lock, profile and commit", async () => {
    const log: string[] = [];
    expect((await applyRemoteUpdateLockedWith(updateSteps(log), "1.1.0", PAIR)).kind).toBe("updated");
    expect(log).toEqual(["lock", "resolve", "profile", "plan", "open", "pre template-lock", "pre profile", "write-lock remote", "write-profile", "commit"]);
  });

  it("R2 refuses missing provenance, changed evidence and an incompatible plan before the transaction", async () => {
    const run = async (over: Partial<RemoteUpdateLockedSteps>, prefetched = PAIR) => {
      const log: string[] = [];
      const error = await applyRemoteUpdateLockedWith(updateSteps(log, over), "1.1.0", prefetched).catch((e: Error) => e.message);
      return [error, log];
    };
    expect(await run({ readTemplateLock: async () => ({ kind: "absent" }) })).toEqual(["remote update provenance is absent", []]);
    const moved = { ...PAIR, candidate: { ...PAIR.candidate, tapSequence: 2 } } as RemoteUpdatePair;
    expect(await run({}, moved)).toEqual(["remote template evidence changed after review; retry the update", ["lock", "resolve"]]);
    const incompatible = { compatible: false, reasons: [{ kind: "drift", message: "m" }] } as unknown as TemplateUpdatePlan;
    expect(await run({ planUpdate: async () => incompatible })).toEqual(["remote template update is incompatible:\n- drift: m", ["lock", "resolve", "profile"]]);
  });

  it("R3 on a transaction fault recovers BEFORE rethrowing the original, and an unsafe recovery refuses instead", async () => {
    const log: string[] = [];
    const failing = { writeProfile: async () => { log.push("write-profile"); throw new Error("disk full"); } };
    await expect(applyRemoteUpdateLockedWith(updateSteps(log, failing), "1.1.0", PAIR)).rejects.toThrow("disk full");
    expect(log.slice(-2)).toEqual(["write-profile", "recover"]);
    const unsafe = { ...failing, recoverJournal: async () => ({ status: "unsafe" }) };
    await expect(applyRemoteUpdateLockedWith(updateSteps([], unsafe), "1.1.0", PAIR)).rejects.toThrow("project journal is unsafe; refusing remote template update");
  });
});
