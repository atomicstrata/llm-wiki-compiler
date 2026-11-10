/**
 * @file test/storage/refresh-plan-binding.test.ts
 * @description The `refresh --stale` plan as ONE body over its four reads,
 * `resolveStaleRefreshFrom`, with no project directory. This file uses it,
 * which exists only after the plan was given reads of its own, so it has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. Three projects are minted on real disk, once: a compiled
 * project with drift (a kept, a changed, a deleted and a new source; a page
 * shared by the kept and changed sources; a page whose only owner is gone; an
 * orphan-flagged page no source owns), a project with no state, and one with a
 * corrupt state. The real `resolveStaleRefresh(root)` answers on disk, the trees
 * are copied into memory, and the directories are removed before any case runs.
 * Each case asks the same plan of the body over reads of the copy, each read
 * running its REAL one body (classified state, freshness snapshot, page scan,
 * source selection) over the copy.
 *
 * THE ROOT ROUTE IS UNCHANGED. The four root readers are spied: the bound route
 * reaches none, and a fresh project planned through `resolveStaleRefresh`
 * reaches each with its exact arguments.
 *
 * NOT SHOWN HERE: the refresh command, compile, and what the disk decides
 * (links, confinement); `refresh-plan.test.ts`, `refresh-pipeline.test.ts` and
 * `refresh-integration.test.ts` show those. The doubles are not a hosted store,
 * not an access-control layer and not `ProjectStore`.
 */

import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as indexgen from "../../src/compiler/indexgen.js";
import { resolveStaleRefresh, resolveStaleRefreshFrom, type RefreshResolution, type StaleRefreshReads } from "../../src/compiler/refresh-plan.js";
import * as freshness from "../../src/freshness/index.js";
import * as sourceScan from "../../src/sources/scan.js";
import { CONCEPTS_DIR, SOURCES_DIR, STATE_FILE } from "../../src/utils/constants.js";
import * as stateRecords from "../../src/utils/state.js";
import type { SourceChange } from "../../src/utils/types.js";
import { sha256Hex as sha } from "../fixtures/state-json.js";
import { tempRootTracker } from "../temp-roots.js";
import { copiedSourceReadsOf } from "./copied-local-reads.js";
import {
  expectRemovedDefaultCopies, mintCopied, pageScanOf, recordsOf, sourceFreshnessOf, writeFiles, type Copy, type Minted,
} from "./copied-project.js";
import { compiledEntry, KEPT_TEXT, page } from "./compiled-seed.js";

const PREFIX = "refresh-plan-binding-";

/** The compiled project: kept and changed share `beta`, `gamma`'s only owner is gone, `new.md` was never compiled. */
const COMPILED = {
  [STATE_FILE]: JSON.stringify({ version: 1, indexHash: "", sources: {
    "kept.md": compiledEntry(sha(KEPT_TEXT), ["alpha", "beta"]),
    "changed.md": compiledEntry("OLD", ["beta"]),
    "gone.md": compiledEntry("G", ["gamma"]),
  } }),
  [`${SOURCES_DIR}/kept.md`]: KEPT_TEXT, [`${SOURCES_DIR}/changed.md`]: "Changed since compile.\n", [`${SOURCES_DIR}/new.md`]: "Never compiled.\n",
  [`${CONCEPTS_DIR}/alpha.md`]: page("title: Alpha"), [`${CONCEPTS_DIR}/beta.md`]: page("title: Beta"),
  [`${CONCEPTS_DIR}/gamma.md`]: page("title: Gamma"), [`${CONCEPTS_DIR}/flagged.md`]: page("title: Flagged\norphaned: true"),
};
/** Changes the compile run might detect; the plan's filter must keep exactly the selected owners. */
const CHANGES: SourceChange[] = [
  { file: "changed.md", status: "changed" }, { file: "gone.md", status: "deleted" }, { file: "kept.md", status: "changed" }, { file: "new.md", status: "new" },
];

/** A resolution as it can be compared: every list, and the change filter applied to {@link CHANGES}. */
function shown(resolution: RefreshResolution): unknown {
  if (resolution.plan === null) return resolution;
  const { changeFilter, ...lists } = resolution.plan;
  return { stateStatus: resolution.stateStatus, ...lists, kept: CHANGES.filter(changeFilter).map((change) => change.file) };
}

const tracker = tempRootTracker();
let compiled: Minted<unknown>;
let noState: Minted<unknown>;
let corrupt: Minted<unknown>;

const mint = (files: Record<string, string>): Promise<Minted<unknown>> =>
  mintCopied(tracker, PREFIX, (root) => writeFiles(root, files), async (root) => shown(await resolveStaleRefresh(root)));

beforeAll(async () => {
  compiled = await mint(COMPILED);
  noState = await mint({ [`${SOURCES_DIR}/a.md`]: "A.\n" });
  corrupt = await mint({ [STATE_FILE]: "{not json", [`${SOURCES_DIR}/a.md`]: "A.\n" });
  await tracker.cleanup();
});
afterAll(() => tracker.cleanup());
afterEach(() => { vi.restoreAllMocks(); });

/** The four reads over one copy, each its real one body; every call is logged as `<read>:<call>`. */
function readsOf(copy: Copy, log: string[]): StaleRefreshReads {
  const note = (read: string) => (call: string): void => { log.push(`${read}:${call}`); };
  return {
    readState: () => stateRecords.readStateClassifiedFrom(recordsOf(copy, note("state"))),
    buildFreshness: (classified) => freshness.buildFreshnessSnapshotFrom(sourceFreshnessOf(copy, note("freshness")), classified),
    scanConcepts: () => indexgen.scanWikiPagesFrom(pageScanOf(copy, CONCEPTS_DIR, note("scan"))),
    listSourceFiles: () => sourceScan.listSelectedSourceFilesFrom(copiedSourceReadsOf(copy, note("sources"))),
  };
}

/** The reads in the order they were first asked, each named once per run. */
const readOrder = (log: string[]): string[] => log.map((call) => call.split(":")[0]!).filter((read, at, all) => read !== all[at - 1]);

describe("the stale-refresh plan over copied projects, with the directories gone", () => {
  it("R1 runs after every minting directory was removed", () => {
    expectRemovedDefaultCopies([compiled, noState, corrupt], PREFIX);
  });

  it("R2 plans a drifted project exactly as the disk did", async () => {
    expect(shown(await resolveStaleRefreshFrom(readsOf(compiled.copy, [])))).toEqual(compiled.onDisk);
    // The case only witnesses each list when the disk produced it.
    expect(compiled.onDisk).toMatchObject({
      stateStatus: "ok", changedOwners: ["changed.md"], deletedOwners: ["gone.md"], knownAffected: ["kept.md"],
      newSkipped: ["new.md"], computedOrphanedPages: ["gamma"], alreadyOrphanedPages: ["flagged"], kept: ["changed.md", "gone.md"],
    });
  });

  it("R3 reads the state, then freshness, the pages and the sources; a missing or corrupt state reads nothing else", async () => {
    const log: string[] = [];
    await resolveStaleRefreshFrom(readsOf(compiled.copy, log));
    expect(readOrder(log)).toEqual(["state", "freshness", "scan", "sources"]);
    for (const project of [noState, corrupt]) {
      const refused: string[] = [];
      expect(shown(await resolveStaleRefreshFrom(readsOf(project.copy, refused)))).toEqual(project.onDisk);
      expect(readOrder(refused)).toEqual(["state"]);
    }
    expect([noState.onDisk, corrupt.onDisk]).toEqual([{ stateStatus: "missing", plan: null }, { stateStatus: "corrupt", plan: null }]);
  });

  it("R4 reaches no root reader from the bound route, while the root route reaches each with its exact arguments", async () => {
    const spies = [vi.spyOn(stateRecords, "readStateClassified"), vi.spyOn(freshness, "buildFreshnessSnapshot"),
      vi.spyOn(indexgen, "scanWikiPages"), vi.spyOn(sourceScan, "listSelectedSourceFiles")];
    await resolveStaleRefreshFrom(readsOf(compiled.copy, []));
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0]);
    const root = await tracker.create(PREFIX);
    await writeFiles(root, COMPILED);
    await resolveStaleRefresh(root);
    expect(spies.map((spy) => spy.mock.calls)).toEqual([
      [[root]], [[root, expect.objectContaining({ status: "ok" })]], [[path.join(root, CONCEPTS_DIR)]], [[root]],
    ]);
  });
});
