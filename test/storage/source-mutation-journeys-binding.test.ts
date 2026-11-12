/**
 * @file test/storage/source-mutation-journeys-binding.test.ts
 * @description The remaining source and mutation journeys, each as ONE body over
 * its own steps, with the root forms delegating over local-disk steps:
 * `saveSourceWith` (`SourceWriterLeaves`), `planRemovalWith`/`applyRemovalWith`
 * (`SourceRemovalSteps`), `deleteWikiPagesWith` (`PageDeleteSteps`),
 * `updateRelationLockedFrom`/`compactRelationsLockedFrom` (relation sources) and
 * `stageEntityPageWith` (`EntityPageStagingSteps`).
 *
 * HOW IT IS BUILT. Memory cases hand each body a scripted double that logs every
 * call, to pin order, short-circuits and refusals. The relation cases wrap the
 * REAL local-disk sources in a logging proxy on a temporary project, so the order
 * is observed against real bytes. The incumbent disk behaviour of every surface
 * stays covered by its existing suites, which run alongside this file.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { computeRemovalPlan } from "../../src/sources/removal-plan.js";
import { applyRemovalWith, localSourceRemovalSteps, planRemovalWith, type SourceRemovalSteps } from "../../src/sources/removal.js";
import * as sourceStore from "../../src/sources/store.js";
import { saveSource, saveSourceWith, type SourceWriterLeaves } from "../../src/utils/source-writer.js";
import { PathSafetyError } from "../../src/viewer/path-safety.js";
import { deleteWikiPagesLocked, deleteWikiPagesWith, type PageDeleteSteps } from "../../src/wiki/delete-page.js";
import * as journal from "../../src/trust/journal.js";
import {
  appendRelation, compactRelationsLockedFrom, diskRelationAppendSources, diskRelationCompactionSources,
  updateRelationLockedFrom,
} from "../../src/relations/store.js";
import { RELATIONS_FILE } from "../../src/utils/constants.js";
import { stageEntityPageWith, type EntityPageStagingSteps, type StageEntityPageInput } from "../../src/trust/staging.js";
import type { PlanResult } from "../../src/trust/planner.js";
import type { WikiState } from "../../src/utils/types.js";
import { RELATED_INPUT, relatedProfile } from "../fixtures/profile-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";

const roots = tempRootTracker();
/** A fresh canonical temporary project root, removed after the file. */
const freshRoot = (): Promise<string> => roots.create("source-mutation-", { real: true });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => roots.cleanup());

/** An error carrying a filesystem code, as the disk leaves raise them. */
const coded = (code: string): Error => Object.assign(new Error(code), { code });
/** An empty, valid state. */
const emptyState = (): WikiState => ({ version: 1, indexHash: "", sources: {} });
/** A member no case should reach. */
const unasked = async (): Promise<never> => { throw new Error("not asked"); };

/** Wrap every function member so each call is logged as `<prefix>.<name>`; returned objects stay unwrapped unless `deep`. */
function logged<T extends object>(target: T, prefix: string, log: string[], deep: Record<string, string> = {}): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(target)) {
    out[name] = typeof value !== "function" ? value : async (...args: unknown[]) => {
      log.push(`${prefix}.${name}`);
      const result = await (value as (...a: unknown[]) => unknown)(...args);
      return deep[name] ? logged(result as object, deep[name]!, log) : result;
    };
  }
  return out as T;
}

describe("saveSource: one body over the writer's leaves", () => {
  /** A scripted writer over one directory `D` holding `files` (name → text); every call logged. */
  function writer(files: Record<string, string>, log: string[], create?: Error): SourceWriterLeaves {
    return {
      openSourcesDir: async () => { log.push("open"); return "D"; },
      listIdentityNames: async () => { log.push("list"); return Object.keys(files); },
      regularFile: async (_dir, name) => `D/${name}`,
      readText: async (file) => files[file.slice(2)]!,
      entryPresent: async (_dir, name) => { log.push(`present ${name}`); return name in files; },
      createExclusive: async (_dir, name, text) => { log.push(`create ${name} ${text}`); if (create) throw create; },
      entryKind: async () => "file",
      overwrite: async (_dir, name, text) => { log.push(`overwrite ${name} ${text}`); },
    };
  }
  const doc = (source: string, body: string) => `---\ntitle: T\nsource: ${source}\ningestedAt: x\n---\n${body}\n`;

  it("W1 refuses an empty slug before any I/O, suffixes a basename collision, and maps EEXIST to the incumbent refusal", async () => {
    const log: string[] = [];
    await expect(saveSourceWith(writer({}, log), "🙂", "x", "s")).rejects.toThrow("Could not derive a filename");
    expect(log).toEqual([]);
    const taken = { "note.md": doc("other", "b") };
    const created = await saveSourceWith(writer(taken, log), "Note", "body", "mine");
    expect([created.writeStatus, created.path]).toEqual(["created", expect.stringMatching(/^D\/note-[0-9a-f]{8}\.md$/)]);
    expect(log.slice(0, 3)).toEqual(["open", "list", "present note.md"]);
    const refused = saveSourceWith(writer({}, [], coded("EEXIST")), "Fresh", "body", "s");
    await expect(refused).rejects.toBeInstanceOf(PathSafetyError);
  });

  it("W2 updates by identity in place: unchanged when only volatile fields differ, overwrite otherwise", async () => {
    const files = { "renamed.md": doc("src-1", "same") };
    const log: string[] = [];
    expect(await saveSourceWith(writer(files, log), "New Title", doc("src-1", "same").replace("ingestedAt: x", "ingestedAt: y"), "src-1"))
      .toEqual({ path: "D/renamed.md", writeStatus: "unchanged" });
    expect(await saveSourceWith(writer(files, log), "New Title", doc("src-1", "changed"), "src-1"))
      .toEqual({ path: "D/renamed.md", writeStatus: "updated" });
    expect(log.filter((entry) => entry.startsWith("overwrite") || entry.startsWith("create")).map((entry) => entry.split(" ")[0])).toEqual(["overwrite"]);
  });

  it("W3 the root form writes the incumbent bytes on a real project, created then unchanged", async () => {
    const root = await freshRoot();
    const first = await saveSource(root, "Real Note", doc("real", "body"), "real");
    expect([first, await readFile(first.path, "utf8")]).toEqual([{ path: path.join(root, "sources", "real-note.md"), writeStatus: "created" }, doc("real", "body")]);
    expect((await saveSource(root, "Real Note", doc("real", "body"), "real")).writeStatus).toBe("unchanged");
  });
});

describe("source removal: one body for the plan and one for the apply", () => {
  /** A state where `a.md` owns `only-a` and shares `both` with `b.md`. */
  const state = (): WikiState => ({
    ...emptyState(),
    sources: { "a.md": { hash: "h", concepts: ["only-a", "both"], compiledAt: "t" }, "b.md": { hash: "h", concepts: ["both"], compiledAt: "t" } },
  });
  function steps(current: WikiState, log: string[]): SourceRemovalSteps {
    return {
      readStateClassified: async () => { log.push("state"); return { status: "ok", state: current }; },
      collectPages: async () => [], listCandidates: async () => [], loadProfile: async () => undefined,
      getSource: async (id) => ({ id, title: id, source: "", sourceType: "file" }),
      sourceFileMissing: async () => false,
      deleteSource: async (id) => { log.push(`source ${id}`); return true; },
      deletePages: async (slugs) => { log.push(`pages ${slugs.join(",")}`); return { skipped: [] }; },
      writeState: async (next) => { log.push(`write frozen=${(next.frozenSlugs ?? []).join(",")} sources=${Object.keys(next.sources).join(",")}`); },
    };
  }

  it("M1 applies source → pages → state from the fresh read, freezing kept slugs; the plan writes nothing", async () => {
    const log: string[] = [];
    const plan = await planRemovalWith(steps(state(), log), "a");
    expect([plan?.deleteSlugs, plan?.keptSlugs, log]).toEqual([["only-a"], ["both"], ["state"]]);
    expect(await applyRemovalWith(steps(state(), log), plan!)).toEqual({ deleted: ["only-a"], skipped: [], sourceDeleted: true });
    expect(log.slice(1)).toEqual(["state", "source a.md", "pages only-a", "write frozen=both sources=b.md"]);
  });

  it("M2 refuses before any mutation when ownership moved, and fails closed on a corrupt state", async () => {
    const plan = computeRemovalPlan({ sourceFile: "a.md", state: state(), pages: [], candidates: [], profileId: null, sourcePresent: true });
    const moved = state();
    moved.sources["b.md"]!.concepts = ["both", "only-a"];
    const log: string[] = [];
    await expect(applyRemovalWith(steps(moved, log), plan)).rejects.toThrow("The project changed");
    expect(log).toEqual(["state"]);
    const corrupt = { ...steps(state(), log), readStateClassified: async () => ({ status: "corrupt" as const, state: emptyState() }) };
    await expect(planRemovalWith(corrupt, "a")).rejects.toThrow("is corrupt");
  });
});

describe("page delete: one body over slug-addressed steps", () => {
  function steps(log: string[], remains: string[] = []): PageDeleteSteps {
    return {
      replayJournal: async () => { log.push("replay"); },
      openBatch: async () => { log.push("open"); return {} as journal.JournalBatch; },
      recordPreState: async (_batch, slug) => { log.push(`record ${slug}`); },
      unlink: async (slug) => { log.push(`unlink ${slug}`); },
      probeNoFollow: async (slug) => { log.push(`probe ${slug}`); if (!remains.includes(slug)) throw coded("ENOENT"); },
      commitBatch: async () => { log.push("commit"); },
    };
  }

  it("P1 replays first, opens no batch when nothing is deletable, verifies each unlink, and never commits a surviving page", async () => {
    const log: string[] = [];
    expect(await deleteWikiPagesWith(steps(log), ["../evil"])).toEqual({ skipped: [{ slug: "../evil", reason: "floor:unsafe-slug" }] });
    expect(log).toEqual(["replay"]);
    log.length = 0;
    await deleteWikiPagesWith(steps(log), ["a", "b"]);
    expect(log).toEqual(["replay", "open", "record a", "unlink a", "probe a", "record b", "unlink b", "probe b", "commit"]);
    log.length = 0;
    await expect(deleteWikiPagesWith(steps(log, ["a"]), ["a"])).rejects.toThrow('failed to delete wiki page "a"');
    expect(log).toEqual(["replay", "open", "record a", "unlink a", "probe a"]);
  });
});

describe("page delete: the unlinkOne hook is read where the incumbent read it", () => {
  it("P2 never reads the hook for an empty or all-skipped call, and reads it once before a real batch", async () => {
    const root = await freshRoot();
    let reads = 0;
    const opts = { get unlinkOne() { reads += 1; return undefined; } };
    await deleteWikiPagesLocked(root, [], opts);
    await deleteWikiPagesLocked(root, ["../evil"], opts);
    expect(reads).toBe(0);
    await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
    await writeFile(path.join(root, "wiki", "concepts", "gone.md"), "x");
    await writeFile(path.join(root, "wiki", "concepts", "also.md"), "y");
    expect(await deleteWikiPagesLocked(root, ["gone", "also"], opts)).toEqual({ skipped: [] });
    expect(reads).toBe(1);
  });
});

describe("relation update and compaction: one body over the real local-disk sources", () => {
  it("L1 updates: base read, then the superseding record, then its event; compaction: read, prepare, re-read, replace, event, size", async () => {
    const root = await freshRoot();
    const profile = relatedProfile();
    const created = await appendRelation(root, profile, RELATED_INPUT);
    const log: string[] = [];
    const base = diskRelationAppendSources(root);
    const updateSources = { graph: logged(base.graph, "graph", log), events: logged(base.events, "events", log) };
    const updated = await updateRelationLockedFrom(updateSources, profile, created.id, { attributes: {} });
    expect(updated.id).toBe(created.id);
    const mainline = (entries: string[]) => entries.filter((entry) => entry.startsWith("graph.") || entry.startsWith("rewrite.") || entry === "events.appendStore");
    expect(mainline(log)).toEqual(["graph.readStore", "graph.appendStore", "events.appendStore"]);
    log.length = 0;
    const compaction = diskRelationCompactionSources(root);
    const compactSources = { graph: logged(compaction.graph, "graph", log, { prepareRewrite: "rewrite" }), events: logged(compaction.events, "events", log) };
    const sizes = await compactRelationsLockedFrom(compactSources, profile);
    expect(mainline(log)).toEqual(["graph.readStore", "graph.prepareRewrite", "graph.readStore", "rewrite.replace", "events.appendStore", "rewrite.size"]);
    expect([sizes.after < sizes.before, (await readFile(path.join(root, RELATIONS_FILE), "utf8")).split("\n").filter(Boolean).length]).toEqual([true, 2]);
  });
});

describe("entity-page staging: one body over the staging steps", () => {
  const profile = relatedProfile();
  const entityType = "experiments";
  const input = (over: Partial<StageEntityPageInput> = {}): StageEntityPageInput => ({
    entityType, slug: "page-a", body: "---\ntitle: A\n---\nbody\n", profile, existingStagedCount: 0, ...over,
  });
  function steps(log: string[], planned: boolean): EntityPageStagingSteps {
    return {
      countCandidates: async () => { log.push("count"); return 0; },
      assertBodyLifecycle: async () => { log.push("lifecycle"); },
      planPage: async (request) => {
        log.push(`plan ${request.allowOverwrite}`);
        const target = { kind: "entity", id: `${entityType}/page-a`, entityType, slug: "page-a" };
        return { decision: "review-required", planned: planned ? [{ target, operation: "create" }] : [] } as unknown as PlanResult;
      },
      writeCandidate: async (_draft, fresh) => { log.push(`write fresh=${fresh}`); return { id: "cand-1" } as never; },
    };
  }

  it("T1 counts, checks the lifecycle, plans and only then writes; a blocked plan or unknown type writes nothing", async () => {
    const log: string[] = [];
    expect((await stageEntityPageWith(steps(log, true), input({ freshCandidateId: true }))).id).toBe("cand-1");
    expect(log).toEqual(["count", "lifecycle", "plan false", "write fresh=true"]);
    log.length = 0;
    await stageEntityPageWith(steps(log, true), input());
    expect(log.at(-1)).toBe("write fresh=undefined");
    log.length = 0;
    await expect(stageEntityPageWith(steps(log, false), input())).rejects.toThrow("blocked by the write planner");
    expect(log).toEqual(["count", "lifecycle", "plan false"]);
    log.length = 0;
    await expect(stageEntityPageWith(steps(log, true), input({ entityType: "nope" }))).rejects.toThrow('entity type "nope" is not declared');
    expect(log).toEqual(["count"]);
  });
});

describe("no ambient I/O from the bodies over doubles", () => {
  it("Z1 the bodies reach no incumbent, while each root form or local step reaches its own with this root", async () => {
    const deleteSource = vi.spyOn(sourceStore, "deleteSource");
    const replay = vi.spyOn(journal, "replayJournal");
    await deleteWikiPagesWith({ replayJournal: async () => {}, openBatch: unasked, recordPreState: unasked, unlink: unasked, probeNoFollow: unasked, commitBatch: unasked }, []);
    await expect(stageEntityPageWith({ countCandidates: async () => 0, assertBodyLifecycle: unasked, planPage: unasked, writeCandidate: unasked }, input0())).rejects.toThrow("not declared");
    expect([deleteSource.mock.calls.length, replay.mock.calls.length]).toEqual([0, 0]);
    const root = await freshRoot();
    await deleteWikiPagesLocked(root, []);
    expect(await localSourceRemovalSteps(root).deleteSource("a.md")).toBe(false);
    expect([replay.mock.calls, deleteSource.mock.calls]).toEqual([[[root]], [[root, "a.md"]]]);
  });
});

/** A staging input whose entity type no profile declares (refused right after the count). */
function input0(): StageEntityPageInput {
  return { entityType: "undeclared", slug: "page-z", body: "x", profile: relatedProfile(), existingStagedCount: 0 };
}
