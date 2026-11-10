/**
 * @file test/storage/project-state-writers-binding.test.ts
 * @description Three small project stores, each as ONE body per operation over its
 * own leaves, with the root forms delegating over the local-disk leaves:
 * readiness skips (`ReadinessSkipLeaves`), rule candidates (`RuleCandidateLeaves`)
 * and sources (`SourceStoreLeaves`).
 *
 * HOW IT IS BUILT. Disk cases use real temporary projects and assert outcomes
 * written down here: exact bytes, what is left on disk, and absent versus
 * unreadable. Memory cases hand each body a scripted double that logs every call,
 * to pin order, refusals and error mapping. A double proves only the body's
 * decisions, not confinement, no-follow or atomicity; those stay in the disk
 * leaves and their own suites.
 */

import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as candidateStorePaths from "../../src/compiler/candidate-store-paths.js";
import { UnsafeCandidateDirError } from "../../src/compiler/candidate-store-paths.js";
import {
  buildRuleCandidate, buildRuleSlug, diskRuleCandidateLeaves, listRuleCandidates, listRuleCandidatesFrom, readRuleCandidate,
  setRuleCandidateStatus, setRuleCandidateStatusFrom, writeRuleCandidate, writeRuleCandidateFrom, archiveRuleCandidate,
  type RuleCandidateLeaves,
} from "../../src/compiler/rule-candidates.js";
import {
  diskReadinessSkipLeaves, readRecordedSkips, readRecordedSkipsFrom, recordSkip, recordSkipFrom, type ReadinessSkipLeaves,
} from "../../src/products/readiness-skips.js";
import {
  deleteSource, deleteSourceFrom, diskSourceStoreLeaves, getSource, getSourceFrom, listSources, listSourcesFrom, sourceFileMissing,
  sourceFileMissingFrom, type SourceStoreLeaves,
} from "../../src/sources/store.js";
import * as diskLocations from "../../src/storage/disk-locations.js";
import * as diskGuardedLeaves from "../../src/storage/disk-guarded-leaves.js";
import * as pathConfine from "../../src/utils/path-confine.js";
import type { RuleCandidate } from "../../src/utils/rule-types.js";
import { tempRootTracker } from "../temp-roots.js";

const roots = tempRootTracker();
/** A fresh temporary project root (canonical, so confined paths compare equal), removed after the file. */
const freshRoot = (): Promise<string> => roots.create("project-state-writers-", { real: true });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => roots.cleanup());

const SKIPS = path.join(".llmwiki", "product-readiness-skips.json");
/** An error carrying a filesystem code, as the disk leaves raise them. */
const coded = (code: string): Error => Object.assign(new Error(code), { code });

describe("readiness skips: one body over the record's own leaf", () => {
  it("K1 keeps absent = empty, writes sorted newline JSON through mkdir, .tmp and rename, and refuses over an unreadable record", async () => {
    const root = await freshRoot();
    expect([...(await readRecordedSkips(root))!]).toEqual([]);
    expect([...(await recordSkip(root, "zeta", true))!]).toEqual(["zeta"]);
    expect([...(await recordSkipFrom(diskReadinessSkipLeaves(root), "alpha", true))!]).toEqual(["zeta", "alpha"]);
    expect(await readFile(path.join(root, SKIPS), "utf8")).toBe(`${JSON.stringify({ skipped: ["alpha", "zeta"] }, null, 2)}\n`);
    expect((await readdir(path.join(root, ".llmwiki"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const unreadable = await freshRoot();
    await mkdir(path.join(unreadable, SKIPS), { recursive: true });
    expect([await readRecordedSkips(unreadable), await recordSkip(unreadable, "alpha", true)]).toEqual([null, null]);
  });

  it("K2 decides in the body: the text-length cap, shape refusals, and no write unless the read succeeded", async () => {
    const run = async (read: Awaited<ReturnType<ReadinessSkipLeaves["readText"]>>) => {
      const log: string[] = [];
      const leaves: ReadinessSkipLeaves = {
        readText: async () => { log.push("read"); return read; },
        writeText: async (render) => { log.push(`write ${render()}`); },
      };
      return [await recordSkipFrom(leaves, "b", true), log];
    };
    expect(await run({ kind: "unavailable" })).toEqual([null, ["read"]]);
    expect(await run({ kind: "ok", text: "x".repeat(64 * 1024 + 1) })).toEqual([null, ["read"]]);
    expect(await run({ kind: "ok", text: '{"skipped":[1]}' })).toEqual([null, ["read"]]);
    expect(await run({ kind: "absent" })).toEqual([new Set(["b"]), ["read", `write ${JSON.stringify({ skipped: ["b"] }, null, 2)}\n`]]);
    expect(await readRecordedSkipsFrom({ readText: async () => ({ kind: "ok", text: '{"skipped":["a"]}' }), writeText: async () => {} })).toEqual(new Set(["a"]));
  });
});

/** One valid candidate with a deterministic id. */
function candidate(title: string): RuleCandidate {
  return buildRuleCandidate({
    category: "general", slug: buildRuleSlug(title, `sig ${title}`), title, description: "d", when: "w", then: "t",
    evidence: [{ kind: "url", url: "https://example.com/r" }], provenance: { source: "sources/a.md" }, confidence: "high",
  }, "2026-01-01T00:00:00.000Z");
}

describe("rule candidates: one body over the store's own leaves", () => {
  it("C1 writes, lists, flips and archives on disk with the incumbent bytes and layout", async () => {
    const root = await freshRoot();
    const [first, second] = [candidate("Beta rule"), candidate("Alpha rule")];
    const target = await writeRuleCandidate(root, first);
    expect(target).toBe(path.join(root, ".llmwiki", "rule-candidates", `${first.id}.json`));
    await writeRuleCandidateFrom(diskRuleCandidateLeaves(root), second);
    expect(await readFile(target, "utf8")).toBe(JSON.stringify(first, null, 2));
    await writeFile(path.join(root, ".llmwiki", "rule-candidates", "broken.json"), "{");
    expect((await listRuleCandidates(root)).map((item) => item.id)).toEqual([second.id, first.id].sort());
    expect((await setRuleCandidateStatusFrom(diskRuleCandidateLeaves(root), first.id, "rejected"))?.status).toBe("rejected");
    expect(await archiveRuleCandidate(root, first.id)).toBe(true);
    expect([await readRuleCandidate(root, first.id), (await readRuleCandidate(root, first.id, "archive"))?.status]).toEqual([null, "rejected"]);
    expect(await setRuleCandidateStatus(root, "missing-id", "approved")).toBeNull();
    expect(await listRuleCandidates(await freshRoot())).toEqual([]);
  });

  it("C2 decides in the body: an absent directory, an invalid file, and read-then-write of the flipped JSON", async () => {
    const valid = candidate("Gamma rule");
    const log: string[] = [];
    const leaves = (files: Record<string, string> | null): RuleCandidateLeaves => ({
      readText: async (fileId, location) => { log.push(`read ${location} ${fileId}`); return files?.[fileId] ?? ""; },
      writeText: async (fileId, render) => { log.push(`write ${fileId} ${render()}`); return `at/${fileId}`; },
      listFileIds: async () => { log.push("list"); return files === null ? null : Object.keys(files); },
      archive: async () => { throw new Error("archive is not asked"); },
    });
    expect(await listRuleCandidatesFrom(leaves(null))).toEqual([]);
    expect(await listRuleCandidatesFrom(leaves({ bad: "{", [valid.id]: JSON.stringify(valid) }))).toEqual([valid]);
    log.length = 0;
    const flipped = await setRuleCandidateStatusFrom(leaves({ [valid.id]: JSON.stringify(valid) }), valid.id, "approved");
    expect([flipped?.status, log]).toEqual(["approved", [`read active ${valid.id}`, `write ${valid.id} ${JSON.stringify({ ...valid, status: "approved" }, null, 2)}`]]);
    expect(await writeRuleCandidateFrom(leaves({}), valid)).toBe(`at/${valid.id}`);
  });
});

describe("serialization waits for the write's own preconditions, as the incumbent did", () => {
  it("O1 confines the candidate path before serializing, and serializes only inside each write", async () => {
    const root = await freshRoot(), outside = await freshRoot();
    await mkdir(path.join(root, ".llmwiki"));
    await symlink(outside, path.join(root, ".llmwiki", "rule-candidates"), "dir");
    const poisoned = { ...candidate("Epsilon rule") };
    Object.defineProperty(poisoned, "createdAt", { enumerable: true, get: () => { throw new Error("serialized before confinement"); } });
    await expect(writeRuleCandidate(root, poisoned)).rejects.toBeInstanceOf(UnsafeCandidateDirError);
    const log: string[] = [];
    const valid = candidate("Zeta rule");
    await setRuleCandidateStatusFrom({
      readText: async () => JSON.stringify(valid), listFileIds: async () => [], archive: async () => false,
      writeText: async (_fileId, render) => { log.push("path", JSON.parse(render()).status); return "at"; },
    }, valid.id, "approved");
    await recordSkipFrom({
      readText: async () => ({ kind: "absent" }),
      writeText: async (render) => { log.push("mkdir", render()); },
    }, "x", true);
    expect(log).toEqual(["path", "approved", "mkdir", `${JSON.stringify({ skipped: ["x"] }, null, 2)}\n`]);
  });
});

describe("sources: one body over the store's own leaves", () => {
  it("S1 lists, gets, probes and deletes real sources, skipping a symlink and keeping missing distinct from occupied", async () => {
    const root = await freshRoot();
    await mkdir(path.join(root, "sources"));
    await writeFile(path.join(root, "sources", "a.md"), "---\ntitle: A\n---\nbody a\n");
    await writeFile(path.join(root, "sources", "b.md"), "plain b\n");
    await symlink(path.join(root, "sources", "a.md"), path.join(root, "sources", "link.md"));
    expect((await listSources(root)).sources.map((item) => item.id)).toEqual(["a.md", "b.md"]);
    expect(await getSource(root, "link.md")).toBeNull();
    expect([await sourceFileMissing(root, "link.md"), await sourceFileMissing(root, "gone.md")]).toEqual([false, true]);
    expect((await getSourceFrom(diskSourceStoreLeaves(root), "a.md"))?.title).toBe("A");
    expect([await deleteSource(root, "b.md"), await deleteSource(root, "b.md")]).toEqual([true, false]);
    expect(await listSources(await freshRoot())).toEqual({ sources: [] });
    await expect(getSource(root, "../escape.md")).rejects.toThrow();
  });

  it("S2 decides in the body: paging and the cursor check, and ENOENT as absent while other faults throw", async () => {
    const log: string[] = [];
    const leaves = (fault?: Error): SourceStoreLeaves => ({
      sourcesDir: async () => { log.push("dir"); return "D"; },
      listIds: async () => { log.push("list"); return ["a.md", "b.md", "c.md"]; },
      regularFile: async (dir, id) => { log.push(`file ${id}`); return id === "b.md" ? null : `${dir}/${id}`; },
      readText: async (file) => { if (fault) throw fault; return `text of ${file}`; },
      removeLeaf: async () => { if (fault) throw fault; },
      probeNoFollow: async () => { if (fault) throw fault; },
    });
    expect(await listSourcesFrom(leaves(), { limit: 2 })).toEqual({ sources: [{ id: "a.md", title: "a.md", source: "", sourceType: "file", ingestedAt: undefined }], cursor: "2" });
    expect(log).toEqual(["dir", "list", "file a.md", "file b.md"]);
    await expect(listSourcesFrom(leaves(), { cursor: "-1" })).rejects.toThrow("invalid listSources cursor: -1");
    const gone = coded("ENOENT"), denied = coded("EACCES");
    expect([await getSourceFrom(leaves(gone), "a.md"), await deleteSourceFrom(leaves(gone), "a.md"), await sourceFileMissingFrom(leaves(gone), "a.md")]).toEqual([null, false, true]);
    await expect(getSourceFrom(leaves(denied), "a.md")).rejects.toThrow("EACCES");
    await expect(deleteSourceFrom(leaves(denied), "a.md")).rejects.toThrow("EACCES");
    await expect(sourceFileMissingFrom(leaves(denied), "a.md")).rejects.toThrow("EACCES");
  });
});

describe("no ambient reads from the bodies; the root forms reach the incumbents with their own arguments", () => {
  it("Z1 bodies over doubles touch no incumbent, while each root form calls them with this root", async () => {
    const root = await freshRoot();
    await mkdir(path.join(root, "sources"));
    await writeFile(path.join(root, "sources", "a.md"), "a\n");
    const sourcesDir = vi.spyOn(pathConfine, "resolveSourcesDir");
    const readText = vi.spyOn(diskLocations, "readLocationText");
    const write = vi.spyOn(diskGuardedLeaves, "writeLeafAtomicUnconfined");
    const candidatesDir = vi.spyOn(candidateStorePaths, "resolveConfinedCandidatesDir");
    const none = async () => { throw new Error("not asked"); };
    await getSourceFrom({ sourcesDir: async () => null, listIds: none, regularFile: none, readText: none, removeLeaf: none, probeNoFollow: none }, "a.md");
    await listRuleCandidatesFrom({ readText: none, writeText: none, listFileIds: async () => null, archive: none });
    await writeRuleCandidateFrom({ readText: none, writeText: async () => "x", listFileIds: none, archive: none }, candidate("Delta rule"));
    expect([sourcesDir, readText, write, candidatesDir].map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0]);
    expect((await getSource(root, "a.md"))?.id).toBe("a.md");
    const target = await writeRuleCandidate(root, candidate("Delta rule"));
    await listRuleCandidates(root);
    expect(sourcesDir.mock.calls).toEqual([[root]]);
    expect(readText.mock.calls.some(([file]) => file === path.join(root, "sources", "a.md"))).toBe(true);
    expect(write.mock.calls.map(([leaf]) => leaf)).toEqual([target]);
    expect(candidatesDir.mock.calls).toEqual([[root, ".llmwiki/rule-candidates"]]);
  });
});
