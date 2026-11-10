/**
 * @file test/storage/preparation-store-walk-binding.test.ts
 * @description The preparation store scanner's REAL walk, run over an
 * in-memory tree through `scanActivePreparationStoreFrom` and
 * `scanPreparationOrphansFrom`. The real classifiers, directory policy, byte
 * caps, entry and depth budgets and problem wording all execute; there is no
 * project root and nothing is read from a disk. What is pinned is the
 * scanner's own decisions: what each leaf is, which directories are entered,
 * ignored or flagged, when a budget refuses and what it counts, the order of
 * the result, and every problem's exact words and path.
 *
 * THE TREE IS NOT A REPLAY. It is plain nested objects that have never been
 * through the scanner. Its provider follows the seam's stated contract: it
 * obtains an entry and THEN asks `take()`, never asks at the end of a
 * directory, delivers nothing more after a refusal, and refuses a directory
 * only before any entry. Its log separates an entry PULLED from one DELIVERED
 * to `inspect`.
 *
 * WHAT THIS IS NOT. The provider opens nothing, so this is NOT evidence of
 * no-follow opening, confinement, handle-bound metadata, or release on every
 * path on a real disk. Its "release" log line records what THIS DOUBLE did and
 * proves nothing about a disk handle. The sizes and identities are numbers the
 * tree made up. It says nothing about the lifecycle proof, the key, or
 * authentication. Nothing here selects a backend.
 */

import { describe, expect, it } from "bun:test";
import {
  MAX_PREPARATION_MANIFEST_BYTES, MAX_PREPARATION_RUN_BYTES,
} from "../../src/preparations/constants.js";
import {
  scanActivePreparationStoreFrom, scanPreparationOrphansFrom, type PreparationStoreWalkReads,
} from "../../src/preparations/orphan-scan.js";
import { entryOf, treeReads, type TreeDirectory, type TreeLeaf, type TreeNode } from "./memory-store-tree.js";

const WS = "research";
const PREP = `prp_${"a".repeat(32)}`;
const RUN = `prr_${"b".repeat(32)}`;
const HEX = "c".repeat(64);
const QUARANTINE = "preparation-quarantine";
const WORKSPACE = `workspaces/${WS}`;
const PREPARATION = `${WORKSPACE}/preparations/${PREP}`;
const RUNS = `${WORKSPACE}/preparation-runs`;
const MAX_DEPTH = 32;
const BOOM = new Error("the read rejected");

let nextInode = 0;

/** A leaf with its own identity; `type` and a refusal may be overridden. */
function leaf(size = 10, extra: Partial<TreeLeaf> = {}): TreeLeaf {
  nextInode += 1;
  return { type: "file", size, ino: nextInode, ...extra };
}

/** A directory of named entries, in the order given. */
function dir(entries: Record<string, TreeNode> = {}, refuse?: TreeDirectory["refuse"]): TreeDirectory {
  return { type: "directory", entries, refuse };
}

/** A store whose one workspace holds `entries`; `rest` are further top-level entries beside `workspaces`. */
function storeOf(entries: Record<string, TreeNode>, rest: Record<string, TreeNode> = {}): TreeDirectory {
  return dir({ workspaces: dir({ [WS]: dir(entries) }), ...rest });
}

/** One preparation with a manifest, an evidence object and a run, each of 10 bytes. */
function preparedStore(): TreeDirectory {
  return storeOf({
    preparations: dir({ [PREP]: dir({ "manifest.json": leaf(), evidence: dir({ [HEX]: leaf() }) }) }),
    "preparation-runs": dir({ [`${RUN}.json`]: leaf() }),
  });
}

/** A chain of `levels` nested directories all named `p`, the innermost empty. */
function nested(levels: number): TreeDirectory {
  return levels === 0 ? dir() : dir({ p: nested(levels - 1) });
}

describe("store walk over an in-memory tree: leaf classification", () => {
  it("S1 names each leaf kind with its ids, and carries the observed size and identity into the record", async () => {
    const manifest = leaf(11);
    const store = storeOf({
      preparations: dir({ [PREP]: dir({ "manifest.json": manifest, evidence: dir({ [HEX]: leaf() }), "stray.txt": leaf() }) }),
      "preparation-runs": dir({ [`${RUN}.json`]: leaf(), [`${RUN}.cancel`]: leaf() }),
    });
    const scan = await scanActivePreparationStoreFrom(treeReads(store).reads);
    expect(scan.leaves[0]).toEqual({
      relativePath: `${PREPARATION}/manifest.json`, logicalRelativePath: `${PREPARATION}/manifest.json`,
      kind: "manifest", bytes: 11, dev: 1, ino: manifest.ino, workspaceId: WS, preparationId: PREP,
    });
    expect(scan.leaves.map((item) => [item.kind, item.preparationId ?? item.runId])).toEqual([
      ["manifest", PREP], ["evidence", PREP], ["unknown", PREP], ["run", RUN], ["cancel", RUN],
    ]);
    expect(scan.problems).toEqual([{
      dimension: "preparation-entry", detail: "unknown preparation leaf", path: `.llmwiki/${PREPARATION}/stray.txt`,
    }]);
    expect([scan.workspaces, scan.preparationDirectories, scan.traversalEntries])
      .toEqual([[WS], [{ workspaceId: WS, preparationId: PREP }], 10]);
  });

  it("S2 a protocol alias keeps its kind, names the alias, and records the logical path without the suffix", async () => {
    const store = storeOf({ preparations: dir({ [PREP]: dir({
      "manifest.json.writing": leaf(), evidence: dir({ [`${HEX}.tmp`]: leaf() }),
    }) }) });
    const scan = await scanActivePreparationStoreFrom(treeReads(store).reads);
    expect(scan.leaves.map((item) => [item.kind, item.protocolAlias, item.logicalRelativePath])).toEqual([
      ["manifest", "writing", `${PREPARATION}/manifest.json`], ["evidence", "tmp", `${PREPARATION}/evidence/${HEX}`],
    ]);
    expect(scan.problems).toEqual([]);
  });
});

describe("store walk over an in-memory tree: directory policy and entry kinds", () => {
  it("S3 foreign and unsafe directories are not entered; unknown ones under the store's own segments are flagged", async () => {
    const store = dir({ workspaces: dir({
      Research: dir({ preparations: dir({ [PREP]: dir({ "manifest.json": leaf() }) }) }),
      [WS]: dir({
        operations: dir({ "bundle.json": leaf() }),
        preparations: dir({ prp_bad: dir({ "manifest.json": leaf() }), [PREP]: dir({ other: dir(), evidence: dir() }) }),
        "preparation-runs": dir({ nested: dir() }),
      }),
    }) });
    const { reads, log } = treeReads(store);
    const scan = await scanActivePreparationStoreFrom(reads);
    expect(log.filter((line) => line.startsWith("release")).map((line) => line.slice("release ".length)).sort()).toEqual([
      PREPARATION, `${PREPARATION}/evidence`, `${WORKSPACE}`, `${WORKSPACE}/preparations`, RUNS, "workspaces",
    ].sort());
    expect(scan.problems.map((problem) => [problem.detail, problem.path])).toEqual([
      ["unknown preparation directory", `.llmwiki/${WORKSPACE}/preparations/prp_bad`],
      ["unknown preparation directory", `.llmwiki/${PREPARATION}/other`],
      ["unknown preparation directory", `.llmwiki/${RUNS}/nested`],
    ]);
    expect(scan.leaves).toEqual([]);
  });
});

describe("store walk over an in-memory tree: entries that are not plain readable leaves", () => {
  it("S4 a workspace catalog is skipped, an unsupported entry is a problem, and a link is observed, not followed", async () => {
    const store = storeOf({
      "catalog.jsonl": leaf(),
      "preparation-runs": dir({
        pipe: leaf(10, { type: "other" }), [`${RUN}.json`]: leaf(10, { type: "link", observe: "unavailable" }),
        [`${RUN}.cancel`]: leaf(10, { observe: "absent" }),
      }),
    });
    const { reads, log } = treeReads(store);
    const scan = await scanActivePreparationStoreFrom(reads);
    expect(log.filter((line) => line.startsWith("observe"))).toEqual([
      `observe ${RUNS}/${RUN}.json in ${RUNS}`, `observe ${RUNS}/${RUN}.cancel in ${RUNS}`,
    ]);
    expect(scan.problems).toEqual([
      { dimension: "preparation-entry", detail: "unsupported preparation entry", path: `.llmwiki/${RUNS}/pipe` },
      { dimension: "leaf-unavailable", detail: "preparation leaf is unavailable", path: `.llmwiki/${RUNS}/${RUN}.json` },
      { dimension: "leaf-unavailable", detail: "preparation leaf is absent", path: `.llmwiki/${RUNS}/${RUN}.cancel` },
    ]);
    expect(scan.leaves).toEqual([]);
  });
});

describe("store walk over an in-memory tree: byte caps", () => {
  it("S8 a leaf at its cap is clean; one byte over is a problem for its kind, and the leaf is still recorded", async () => {
    const store = storeOf({
      preparations: dir({ [PREP]: dir({ "manifest.json": leaf(MAX_PREPARATION_MANIFEST_BYTES) }) }),
      "preparation-runs": dir({
        [`${RUN}.json`]: leaf(MAX_PREPARATION_RUN_BYTES + 1), [`${RUN}.cancel`]: leaf(MAX_PREPARATION_RUN_BYTES + 1),
      }),
    });
    const scan = await scanActivePreparationStoreFrom(treeReads(store).reads);
    expect(scan.problems).toEqual([
      { dimension: "run-bytes", detail: "preparation leaf exceeds its byte cap", path: `.llmwiki/${RUNS}/${RUN}.json` },
      { dimension: "cancel-bytes", detail: "preparation leaf exceeds its byte cap", path: `.llmwiki/${RUNS}/${RUN}.cancel` },
    ]);
    expect(scan.leaves.map((item) => item.kind)).toEqual(["manifest", "run", "cancel"]);
  });
});

describe("store walk over an in-memory tree: the entry budget asks after an entry is in hand", () => {
  /** Five entries in all: the workspace, `preparations`, the preparation, its manifest, then `zz` beside `preparations`. */
  const chain = (): TreeDirectory => storeOf({
    preparations: dir({ [PREP]: dir({ "manifest.json": leaf() }) }), zz: dir(),
  });

  it("S9 a limit equal to the entries present raises nothing and counts exactly that many", async () => {
    const scan = await scanActivePreparationStoreFrom(treeReads(chain()).reads, { maxDirectoryEntriesForTest: 5 });
    expect([scan.problems, scan.traversalEntries, scan.leaves.length]).toEqual([[], 5, 1]);
  });

  it("S9 one entry over raises ONE problem in the refusing directory, counts N+1, and delivers nothing more", async () => {
    const { reads, log } = treeReads(chain());
    const scan = await scanActivePreparationStoreFrom(reads, { maxDirectoryEntriesForTest: 3 });
    expect(scan.problems).toEqual([{
      dimension: "directory-entries", detail: "preparation inventory entry bound exceeded", path: `.llmwiki/${PREPARATION}`,
    }]);
    expect([scan.traversalEntries, scan.leaves]).toEqual([4, []]);
    expect(log.slice(-6)).toEqual([
      `pull ${PREPARATION}/manifest.json`, `release ${PREPARATION}`, `release ${WORKSPACE}/preparations`,
      `pull ${WORKSPACE}/zz`, `release ${WORKSPACE}`, "release workspaces",
    ]);
    expect(log).not.toContain(`deliver ${PREPARATION}/manifest.json`);
  });
});

describe("store walk over an in-memory tree: directory refusals and the depth budget", () => {
  it("S11 an absent walk root is silent; an unavailable or unlistable one is worded and located", async () => {
    expect((await scanActivePreparationStoreFrom(treeReads(dir()).reads)).problems).toEqual([]);
    for (const [refuse, detail] of [
      ["unavailable", "preparation directory is unavailable"], ["unlistable", "preparation directory cannot be listed"],
    ] as const) {
      const scan = await scanActivePreparationStoreFrom(treeReads(dir({ workspaces: dir({}, refuse) })).reads);
      expect(scan.problems).toEqual([{ dimension: "directory-unavailable", detail, path: ".llmwiki/workspaces" }]);
      expect(scan.traversalEntries).toBe(0);
    }
  });

  it("S10 the directory at depth 33 is refused, only through the combined form, with no entry-bound problem", async () => {
    const { reads, log } = treeReads(dir({ [QUARANTINE]: nested(MAX_DEPTH + 1) }));
    const scan = await scanPreparationOrphansFrom(reads);
    const refused = [QUARANTINE, ...Array.from({ length: MAX_DEPTH + 1 }, () => "p")].join("/");
    expect(scan.problems).toEqual([{
      dimension: "directory-depth", detail: "preparation inventory depth exceeded", path: `.llmwiki/${refused}`,
    }]);
    expect(scan.traversalEntries).toBe(MAX_DEPTH + 1);
    expect(log).toContain(`deliver ${refused}`);
    expect(log).not.toContain(`release ${refused}`);
  });
});

describe("store walk over an in-memory tree: order and the two forms", () => {
  it("S12 leaves keep visit order while workspaces and preparation directories come back sorted", async () => {
    const prepared = (): TreeDirectory => dir({ preparations: dir({ [PREP]: dir({ "manifest.json": leaf() }) }) });
    const scan = await scanActivePreparationStoreFrom(treeReads(dir({ workspaces: dir({ zeta: prepared(), alpha: prepared() }) })).reads);
    expect(scan.leaves.map((item) => item.workspaceId)).toEqual(["zeta", "alpha"]);
    expect(scan.workspaces).toEqual(["alpha", "zeta"]);
    expect(scan.preparationDirectories.map((item) => item.workspaceId)).toEqual(["alpha", "zeta"]);
  });

  it("S13 the active form never visits the quarantine segment", async () => {
    const store = storeOf({}, { [QUARANTINE]: dir({ "reset-1": dir({ "held.json": leaf() }) }) });
    const { reads, log } = treeReads(store);
    expect((await scanActivePreparationStoreFrom(reads)).leaves).toEqual([]);
    expect(log.some((line) => line.includes(QUARANTINE))).toBe(false);
  });

  it("S14 the combined form walks workspaces, then quarantine: its leaf kind, and a non-portable partition flagged", async () => {
    const store = { ...preparedStore() };
    store.entries = { ...store.entries, [QUARANTINE]: dir({ "reset-1": dir({ "held.json": leaf() }), "Bad!": dir() }) };
    const scan = await scanPreparationOrphansFrom(treeReads(store).reads);
    expect(scan.leaves.map((item) => item.kind)).toEqual(["manifest", "evidence", "run", "quarantine"]);
    expect(scan.leaves.at(-1)?.relativePath).toBe(`${QUARANTINE}/reset-1/held.json`);
    expect(scan.problems).toEqual([{
      dimension: "preparation-entry", detail: "unknown preparation directory", path: `.llmwiki/${QUARANTINE}/Bad!`,
    }]);
  });

  it("S14 ONE budget spans both walks: exhausted in workspaces, the quarantine segment is never visited", async () => {
    const store = { ...preparedStore() };
    store.entries = { ...store.entries, [QUARANTINE]: dir({ "reset-1": dir() }) };
    const { reads, log } = treeReads(store);
    const scan = await scanPreparationOrphansFrom(reads, { maxDirectoryEntriesForTest: 2 });
    expect(scan.problems.map((problem) => problem.dimension)).toEqual(["directory-entries"]);
    expect(log.some((line) => line.includes(QUARANTINE))).toBe(false);
  });
});

describe("store walk over an in-memory tree: rejections and the entry-limit option", () => {
  it("S15 a rejecting leaf observation or directory visit rejects the scan with the same object", async () => {
    const { reads } = treeReads(preparedStore());
    await expect(scanActivePreparationStoreFrom({ ...reads, observeLeaf: () => Promise.reject(BOOM) })).rejects.toBe(BOOM);
    await expect(scanPreparationOrphansFrom({ ...reads, visitDirectory: () => Promise.reject(BOOM) })).rejects.toBe(BOOM);
  });

  it("S15 a failure in the middle of a visit rejects; it is never reported as a refusal", async () => {
    const { reads } = treeReads(preparedStore());
    const failing: PreparationStoreWalkReads = {
      ...reads,
      visitDirectory: async (directory, visitor) => {
        if (directory !== WORKSPACE) return reads.visitDirectory(directory, visitor);
        await visitor.inspect(entryOf("preparations", dir()));
        throw BOOM;
      },
    };
    await expect(scanActivePreparationStoreFrom(failing)).rejects.toBe(BOOM);
  });

  it("S16 an invalid entry limit rejects before the store is asked anything", async () => {
    const { reads, log } = treeReads(preparedStore());
    for (const scan of [scanActivePreparationStoreFrom, scanPreparationOrphansFrom]) {
      await expect(scan(reads, { maxDirectoryEntriesForTest: 0 }))
        .rejects.toThrow("preparation inventory entry bound must be a positive safe integer");
    }
    expect(log).toEqual([]);
  });
});
