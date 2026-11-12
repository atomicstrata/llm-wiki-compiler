/**
 * @file test/storage/product-workflow-storage-binding.test.ts
 * @description The installed-product and local-workflow project-storage journeys,
 * each as ONE body over its own steps, with the root forms delegating over
 * per-call local-disk steps: the run key (`RunKeyStore`), signed run persistence
 * (`RunRecordStore`), the derived projection (`ProjectionSteps`), the entity
 * postimage digest (`EntityPageBytesReads`), the reconcile store snapshot
 * (`PackStoreSnapshotReads`) and product activation (`ProductActivationSteps`).
 *
 * HOW IT IS BUILT. Memory cases hand each body a scripted double that logs every
 * call, to pin order, refusals and what is signed or written. A double proves only
 * the body's decisions; the real disk journeys (init, install, activate, invoke,
 * resume, projection, snapshot) stay covered by their existing suites, which run
 * alongside this file.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { loadOrCreateRunKeyWith, type RunKeyStore } from "../../src/local-workflow-host/run-key.js";
import { writeRunCandidatesWith, writeRunWith, type RunRecordStore } from "../../src/local-workflow-host/run-store.js";
import {
  writeLocalWorkflowProjection, writeLocalWorkflowProjectionWith, type ProjectionSteps, type ProjectionTargetProbe,
} from "../../src/local-workflow-host/projection.js";
import { readLocalWorkflowEntityDigestFrom } from "../../src/local-workflow-host/entity-digest.js";
import { packStoreSnapshotFrom, type PackStoreSnapshotReads } from "../../src/operations-packs/runtime/store-snapshot.js";
import { activateUnderLockWith, localProductActivationSteps, type ProductActivationSteps } from "../../src/products/binding/activate.js";
import * as packageStore from "../../src/products/packages/store.js";
import * as profileLoad from "../../src/profile/load.js";
import { runIntegrity } from "../../src/workflow-history/integrity.js";
import type { WorkflowRun } from "../../src/workflow-history/types.js";
import type { EntityPage, EntityTypeDef, LoadedProfile } from "../../src/profile/types.js";
import type { Sha256Digest } from "../../src/products/types.js";
import { tempRootTracker } from "../temp-roots.js";

const roots = tempRootTracker();
/** A fresh canonical temporary project root, removed after the file. */
const freshRoot = (): Promise<string> => roots.create("product-workflow-", { real: true });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => roots.cleanup());

const KEY = Buffer.alloc(32, 7);
/** A minimal run record; the codec only serializes and signs what it is given. */
const run = (runId: string, pad = ""): WorkflowRun => ({
  schemaVersion: 2, runId, workflowId: "w", workflowDigest: "d", profileDigest: "p", knownStageIds: [],
  status: "running", currentStage: null, stageLog: [], events: [], satisfiedGates: [], inputs: pad ? { pad } : {},
} as unknown as WorkflowRun);

describe("run key and signed run persistence", () => {
  it("K1 reuses a decodable key, and mints and replaces on absent or undecodable bytes, resolving the key once", async () => {
    const log: string[] = [];
    const store = (read: Awaited<ReturnType<Awaited<ReturnType<RunKeyStore["openKey"]>>["read"]>>): RunKeyStore => ({
      openKey: async () => { log.push("open"); return { read: async () => read, replace: async (text) => { log.push(`replace ${Buffer.from(text, "base64").length}`); } }; },
    });
    expect(await loadOrCreateRunKeyWith(store({ kind: "ok", body: KEY.toString("base64") }))).toEqual(KEY);
    expect(log).toEqual(["open"]);
    log.length = 0;
    for (const read of [{ kind: "absent" as const }, { kind: "ok" as const, body: "not-a-key" }]) {
      expect((await loadOrCreateRunKeyWith(store(read))).length).toBe(32);
    }
    expect(log).toEqual(["open", "replace 32", "open", "replace 32"]);
  });

  it("R1 refuses a bad id before the key, signs with one key, and the candidate path skips oversize then persists once", async () => {
    const log: string[] = [];
    const store: RunRecordStore = {
      loadKey: async () => { log.push("key"); return KEY; },
      persist: async (runId, json) => { log.push(`persist ${runId} ${JSON.parse(json).integrity === runIntegrity(KEY, run(runId)) ? "signed" : "?"}`); },
    };
    await expect(writeRunWith(store, run("../bad"))).rejects.toThrow("not slug-safe");
    expect(log).toEqual([]);
    await writeRunWith(store, run("run-a"));
    expect(log).toEqual(["key", "persist run-a signed"]);
    log.length = 0;
    const kept = await writeRunCandidatesWith(store, [run("run-b", "x".repeat(300 * 1024)), run("run-b")]);
    expect([kept.integrity, log]).toEqual([runIntegrity(KEY, run("run-b")), ["key", "persist run-b signed"]]);
    await expect(writeRunCandidatesWith(store, [run("run-c", "x".repeat(300 * 1024)), run("run-d")])).rejects.toThrow("invalid or changed");
    await expect(writeRunCandidatesWith(store, [])).rejects.toThrow("no run candidates supplied");
  });
});

describe("derived projection: the overwrite rule in the body", () => {
  function steps(probe: ProjectionTargetProbe, log: string[], escapes = false): ProjectionSteps {
    return {
      loadWorkflows: async () => ({ w: { projectionFile: "wiki/w.md" } }) as never,
      confineTarget: async (file) => {
        log.push(`confine ${file}`);
        if (escapes) throw new Error("escape");
        return { probe: async () => { log.push("probe"); return probe; }, write: async () => { log.push("write"); } };
      },
    };
  }
  const BODY = "---\n---\n<!-- DERIVED from the workflow run JSON -->\n";

  it("P1 writes over missing or a prior projection only; refuses a non-projection, a non-file, an escape or a non-derived body", async () => {
    const outcome = async (probe: ProjectionTargetProbe, body = BODY, escapes = false) => {
      const log: string[] = [];
      return [(await writeLocalWorkflowProjectionWith(steps(probe, log, escapes), "w", body)).status, log.join(",")];
    };
    expect(await outcome({ kind: "missing" })).toEqual(["written", "confine wiki/w.md,probe,write"]);
    expect(await outcome({ kind: "file", head: BODY })).toEqual(["written", "confine wiki/w.md,probe,write"]);
    expect(await outcome({ kind: "file", head: "# authored" })).toEqual(["unavailable", "confine wiki/w.md,probe"]);
    expect(await outcome({ kind: "not-file" })).toEqual(["unavailable", "confine wiki/w.md,probe"]);
    expect(await outcome({ kind: "missing" }, BODY, true)).toEqual(["unavailable", "confine wiki/w.md"]);
    expect(await outcome({ kind: "missing" }, "plain")).toEqual(["unavailable", ""]);
    expect((await writeLocalWorkflowProjectionWith(steps({ kind: "missing" }, []), "other", BODY)).status).toBe("no-target");
  });
});

describe("entity digest and store snapshot", () => {
  it("E1 hashes exactly the bytes returned, and reports absence", async () => {
    const def = {} as EntityTypeDef;
    expect(await readLocalWorkflowEntityDigestFrom({ readPageBytes: async () => null }, def, "s")).toBeNull();
    expect(await readLocalWorkflowEntityDigestFrom({ readPageBytes: async () => Buffer.from("abc") }, def, "s"))
      .toBe(`sha256:${createHash("sha256").update("abc").digest("hex")}`);
  });

  it("S1 refuses an unhealthy scan, counts a failed listing as zero, and digests the actual page bytes", async () => {
    const loaded = { profile: { entities: { notes: { directory: "wiki/notes" } } } } as unknown as LoadedProfile;
    const page = { entityType: "notes", slug: "a", filePath: "/x/a.md", frontmatter: { title: "A", tags: ["t"] } } as unknown as EntityPage;
    const reads = (pages: EntityPage[], listing: string[] | Error, scans: number): PackStoreSnapshotReads => ({
      loadProfile: async () => loaded,
      collectPages: async () => ({ pages, problems: [] }),
      scanDir: async () => ({ scans: Array.from({ length: scans }, () => ({ parseStatus: { malformedFrontmatter: false } })), dirStatus: "ok" }) as never,
      listDir: async () => { if (listing instanceof Error) throw listing; return listing; },
      readPageBytes: async () => Buffer.from("on-disk bytes"),
    });
    expect(await packStoreSnapshotFrom(reads([], new Error("ENOENT"), 0), "notes")).toEqual({ kind: "ok", items: [] });
    expect((await packStoreSnapshotFrom(reads([page], ["a.md", "b.md"], 1), "notes")).kind).toBe("refused");
    expect(await packStoreSnapshotFrom(reads([page], ["a.md"], 1), "notes")).toEqual({ kind: "ok", items: [{
      itemId: "a", fields: { title: "A", "current-digest": createHash("sha256").update("on-disk bytes").digest("hex"), "current-byte-count": 13 },
    }] });
    expect((await packStoreSnapshotFrom(reads([], [], 0), "undeclared")).kind).toBe("refused");
  });
});

describe("product activation: refusals in order, nothing written on refusal", () => {
  const DIGEST = `sha256:${"a".repeat(64)}` as Sha256Digest;
  function steps(log: string[], over: Partial<ProductActivationSteps>): ProductActivationSteps {
    return {
      readInstalledPackage: async () => { log.push("package"); return { status: "absent" } as never; },
      profileJsonPresent: async () => { log.push("legacy"); return false; },
      readMemberText: async () => { log.push("member"); throw new Error("unreadable"); },
      loadKnowledgeProfile: () => { throw new Error("not reached"); },
      writeBinding: async () => { log.push("write"); },
      resolveActive: async () => { log.push("resolve"); throw new Error("not reached"); },
      ...over,
    };
  }
  const principal = { id: "op", surface: "cli" } as never;

  it("A1 refuses a missing package before the legacy check, a legacy profile before any member read, and structural incompatibility without writing", async () => {
    const log: string[] = [];
    await expect(activateUnderLockWith(steps(log, {}), DIGEST, principal, {})).rejects.toThrow("installed package is absent");
    expect(log).toEqual(["package"]);
    const ok = { readInstalledPackage: async () => { log.push("package"); return { status: "ok", manifest: { packageDigest: DIGEST, compositionLock: { digest: DIGEST }, rootOperationsPack: { digest: DIGEST }, knowledgeProfile: { digest: DIGEST } }, verifiedMembers: new Map() } as never; } };
    log.length = 0;
    await expect(activateUnderLockWith(steps(log, { ...ok, profileJsonPresent: async () => { log.push("legacy"); return true; } }), DIGEST, principal, {})).rejects.toThrow("legacy profile.json");
    expect(log).toEqual(["package", "legacy"]);
    log.length = 0;
    await expect(activateUnderLockWith(steps(log, ok), DIGEST, principal, {})).rejects.toThrow("structural incompatibility");
    expect(log).toEqual(["package", "legacy", "member", "member"]);
  });
});

describe("no ambient reads from the bodies; the root forms reach their incumbents with this root", () => {
  it("Z1 bodies over doubles reach no incumbent, while each root form or local step calls its own with this root", async () => {
    const loadProfile = vi.spyOn(profileLoad, "loadProfile");
    const readPackage = vi.spyOn(packageStore, "readInstalledProductPackage");
    await writeLocalWorkflowProjectionWith({ loadWorkflows: async () => undefined, confineTarget: async () => { throw new Error("not asked"); } }, "w", "x");
    expect([loadProfile.mock.calls.length, readPackage.mock.calls.length]).toEqual([0, 0]);
    const root = await freshRoot();
    expect((await writeLocalWorkflowProjection(root, "w", "x")).status).toBe("no-target");
    expect((await localProductActivationSteps(root).readInstalledPackage(`sha256:${"b".repeat(64)}` as Sha256Digest)).status).not.toBe("ok");
    expect([loadProfile.mock.calls, readPackage.mock.calls]).toEqual([[[root]], [[root, `sha256:${"b".repeat(64)}`]]]);
  });
});
