/**
 * @file test/storage/page-apply-binding.test.ts
 * @description The shared per-page APPLY, WHOLE, over page I/O held in memory:
 * `applyPageMutationLockedFrom` re-asserts the identity floor before any I/O,
 * confines the target, deletes a present page (an absent one is a no-op with no
 * floor and no record), refuses a create collision before the floor, applies the
 * net-growth floor (an unreadable page counts as 0 characters), records the
 * pre-state BEFORE the write, and writes. It exists only after the apply was
 * given a body of its own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. One project is minted on real disk, once, and copied BEFORE
 * its disk ask (`mintCopiedBeforeAsk`). The disk ask runs every step through the
 * real root form `applyPageMutationLocked` with the default writer and an
 * explicit recorder object (so no legacy journal batch is opened), and settles
 * each step exactly once: `ok` or the error, the recorded pre-state paths, and
 * the wiki tree's digests. Paths are shown relative to the project, and messages
 * with the root replaced by `<root>`. The minting directory is removed before
 * any case runs, and the copy is checked LITERALLY against the seed before every
 * memory replay. Expected outcomes are written out from the source rules.
 *
 * WHAT IS MEMORY ONLY. The operation order, the injected faults, and the proof
 * that the bound body makes no ambient disk call. The legacy `JournalBatch`
 * recorder (journal on disk), real confinement, links and hard links stay with
 * the incumbent page-apply and delete-journal suites.
 */

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import * as diskLeaves from "../../src/storage/disk-guarded-leaves.js";
import { applyPageMutationLocked, applyPageMutationLockedFrom, type PageApplyIo, type PreStateRecorder, type WriteOne } from "../../src/trust/page-apply.js";
import type { PagePlannedMutation } from "../../src/trust/planner.js";
import type { EntityId } from "../../src/profile/types.js";
import { MAX_SOURCE_CHARS } from "../../src/utils/constants.js";
import * as confine from "../../src/utils/path-confine.js";
import { tempRootTracker } from "../temp-roots.js";
import { type Copy } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";
import { diskLeaves as readDiskLeaves, expectHoldsExactly, mintSeededBeforeAsk } from "./project-tree.js";
import { confinedUnder } from "./journal-paths.js";

const PREFIX = "page-apply-binding-";
const MEM_ROOT = path.resolve("/memory/project");
const GOOD = "---\ntitle: Ok\n---\n\nbody\n";
const BAD_FRONTMATTER = "---\ntitle: : : bad\n  nope\n---\n\nbody\n";
const BIG = (fill: string): string => `---\ntitle: Big\n---\n\n${fill.repeat(MAX_SOURCE_CHARS + 10)}\n`;
const SEED = { "wiki/concepts/existing.md": GOOD, "wiki/concepts/big.md": BIG("y") };
const sha = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

const raw = (operation: PagePlannedMutation["operation"], slug: string, body = GOOD): PagePlannedMutation =>
  ({ kind: "page", operation, target: { directory: "concepts", slug }, body, provenance: { origin: "agent", decision: "allow", reviewRouted: false } });
const STEPS: PagePlannedMutation[] = [
  raw("create", "fresh"), raw("create", "existing"), raw("update", "existing", `${GOOD}more\n`), raw("update", "big", BIG("z")),
  raw("update", "big", `${BIG("z")}z`), raw("delete", "existing"), raw("delete", "existing"), raw("create", "../x"),
  { ...raw("create", "novel"), target: { entityType: "papers", slug: "novel", id: "papers/novel" as EntityId } }, raw("create", "badfm", BAD_FRONTMATTER),
];
/** One apply over a step's own recorder; the outcome is read afterwards. */
type Apply = (mutation: PagePlannedMutation, recorder: PreStateRecorder) => Promise<void>;
interface Side { apply: Apply; base: string; tree: () => Promise<Record<string, string>> }
interface Outcome { settled: string; recorded: string[]; tree: Record<string, string> }

/** Run every step, settling each exactly once, then reading the recorded paths and the tree. */
async function runSteps(side: Side, steps: PagePlannedMutation[] = STEPS): Promise<string[]> {
  const outcomes: string[] = [];
  const rel = (abs: string): string => path.relative(side.base, abs).split(path.sep).join("/");
  for (const mutation of steps) {
    const recorded: string[] = [];
    const recorder: PreStateRecorder = { recordPreState: async (abs) => { recorded.push(rel(abs)); } };
    const settled = await side.apply(mutation, recorder).then(() => "ok", (error: Error) => `${error.name}: ${error.message.split(side.base).join("<root>")}`);
    outcomes.push(JSON.stringify({ settled, recorded, tree: await side.tree() }));
  }
  return outcomes;
}

/** The real wiki tree's digests, POSIX-relative to the project. */
const diskTree = (root: string): Promise<Record<string, string>> => readDiskLeaves(root, { rel: "wiki", show: (bytes) => sha(bytes.toString("utf-8")) });

const tracker = tempRootTracker();
const minted = mintSeededBeforeAsk(tracker, PREFIX, SEED, async (root) =>
  runSteps({ apply: (mutation, recorder) => applyPageMutationLocked(root, mutation, recorder), base: await realpath(root), tree: () => diskTree(root) }));

/** The copy, after requiring LITERALLY that it holds exactly the seed. */
function seededCopy(): Copy {
  expectHoldsExactly(minted.copy.files, SEED);
  return minted.copy;
}

/** Faults with no disk twin: a rejecting presence probe or write, or a capped read that answers `unavailable`. */
interface Faults { present?: Error; unreadable?: boolean; write?: Error }

/** Page I/O and the writer over one map seeded from the copy (POSIX keys under `MEM_ROOT`), every call logged. */
function memorySide(log: string[], faults: Faults = {}): Side & { io: PageApplyIo; writeOne: WriteOne } {
  const held = new Map(seededCopy().files);
  const key = (abs: string): string => path.relative(MEM_ROOT, abs).split(path.sep).join("/");
  const io: PageApplyIo = {
    confineTarget: async (targetPath, root) => {
      log.push(`confine ${targetPath.split(path.sep).join("/")}`);
      return confinedUnder(root, targetPath);
    },
    leafPresent: async (dir, name) => { log.push(`present ${key(path.join(dir, name))}`); if (faults.present) throw faults.present; return held.has(key(path.join(dir, name))); },
    readConfinedLeafText: async (_root, leaf, _dir, maxBytes) => {
      log.push(`read ${key(leaf)}`);
      if (faults.unreadable) return { kind: "unavailable" };
      const text = held.get(key(leaf));
      return text === undefined ? { kind: "absent" } : Buffer.byteLength(text) > maxBytes ? { kind: "unavailable" } : { kind: "ok", body: text };
    },
    removeLeaf: async (leaf) => { log.push(`remove ${key(leaf)}`); if (!held.delete(key(leaf))) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
  };
  const writeOne: WriteOne = async (abs, content) => { log.push(`write ${key(abs)}`); if (faults.write) throw faults.write; held.set(key(abs), content); };
  const tree = async () => Object.fromEntries([...held].filter(([rel]) => rel.startsWith("wiki/")).sort(([a], [b]) => a.localeCompare(b)).map(([rel, text]) => [rel, sha(text)]));
  const apply: Apply = (mutation, recorder) => applyPageMutationLockedFrom(io, MEM_ROOT, mutation, recorder, writeOne);
  return { io, writeOne, apply, base: MEM_ROOT, tree };
}

/** Replay every step in memory and require the disk's outcomes. */
async function expectDiskParity(): Promise<Outcome[]> {
  const outcomes = await runSteps(memorySide([]));
  expect(outcomes).toEqual(minted.onDisk);
  return outcomes.map((outcome) => JSON.parse(outcome) as Outcome);
}

describe("the per-page apply over a copied project, with the minting directory gone", () => {
  it("A1 runs after the minting directory was removed, on a copy holding exactly the seed", () => {
    expectMintingDirectoryRemoved(minted.dir, PREFIX);
    seededCopy();
  });

  it("A2 creates, refuses a create collision before the floor, updates, and admits a no-growth rewrite of an over-cap page, as the disk did", async () => {
    const [created, collided, updated, sameSize, grown] = await expectDiskParity();
    expect([created!.settled, created!.recorded, "wiki/concepts/fresh.md" in created!.tree]).toEqual(["ok", ["wiki/concepts/fresh.md"], true]);
    const collidedAt = ["<root>", "wiki", "concepts", "existing.md"].join(path.sep);
    expect([collided!.settled, collided!.recorded]).toEqual([`CreateCollisionError: create-collision: target already exists, refusing to overwrite: ${collidedAt}`, []]);
    expect([updated!.settled, updated!.recorded, sameSize!.settled, sameSize!.tree["wiki/concepts/big.md"]]).toEqual(["ok", ["wiki/concepts/existing.md"], "ok", sha(BIG("z"))]);
    expect([grown!.settled, grown!.recorded]).toEqual([`MutationFloorError: mutation-floor: refused before write: body ${BIG("z").length + 1} chars exceeds cap of ${BIG("z").length}`, []]);
  });

  it("A3 deletes a present page with its pre-state recorded, and treats an absent one as done with nothing recorded, as the disk did", async () => {
    const [, , , , , removed, again] = await expectDiskParity();
    expect([removed!.settled, removed!.recorded, "wiki/concepts/existing.md" in removed!.tree]).toEqual(["ok", ["wiki/concepts/existing.md"], false]);
    expect([again!.settled, again!.recorded, again!.tree]).toEqual(["ok", [], removed!.tree]);
  });

  it("A4 refuses an unsafe raw identity, writes a typed page, and refuses malformed frontmatter, as the disk did", async () => {
    const [, , , , , , , unsafe, typed, malformed] = await expectDiskParity();
    expect([unsafe!.settled, unsafe!.recorded]).toEqual(["InvalidIdentityError: invalid-identity: directory/slug is not a safe filename component: concepts/../x", []]);
    expect([typed!.settled, typed!.recorded]).toEqual(["ok", ["wiki/papers/novel.md"]]);
    expect([malformed!.settled, malformed!.recorded]).toEqual(["MutationFloorError: mutation-floor: refused before write: frontmatter block is present but not valid YAML mapping", []]);
  });

  it("A5 confines, probes or reads, records BEFORE writing or removing, and makes no I/O for an unsafe identity (memory only)", async () => {
    const traces: string[][] = [];
    for (const step of [STEPS[0]!, STEPS[2]!, STEPS[5]!, STEPS[7]!]) {
      const log: string[] = [];
      const side = memorySide(log);
      await side.apply(step, { recordPreState: async () => { log.push("record"); } }).catch(() => undefined);
      traces.push(log);
    }
    expect(traces).toEqual([
      ["confine wiki/concepts/fresh.md", "present wiki/concepts/fresh.md", "record", "write wiki/concepts/fresh.md"],
      ["confine wiki/concepts/existing.md", "read wiki/concepts/existing.md", "record", "write wiki/concepts/existing.md"],
      ["confine wiki/concepts/existing.md", "present wiki/concepts/existing.md", "record", "remove wiki/concepts/existing.md"],
      [],
    ]);
  });

  it("A6 reads a presence fault as free, an unreadable page as 0 characters, and stops at a recorder or write failure (memory only)", async () => {
    const fault = Object.assign(new Error("EIO: probe refused"), { code: "EIO" });
    const collide = await runSteps(memorySide([], { present: fault }), [STEPS[1]!]);
    const unreadable = await runSteps(memorySide([], { unreadable: true }), [STEPS[3]!]);
    const log: string[] = [];
    const recorderFails = await memorySide(log).apply(STEPS[0]!, { recordPreState: async () => { throw fault; } }).catch((error: Error) => error.message);
    const writeFails = await memorySide([], { write: fault }).apply(STEPS[0]!, { recordPreState: async () => undefined }).catch((error: Error) => error.message);
    expect([(JSON.parse(collide[0]!) as Outcome).settled, (JSON.parse(unreadable[0]!) as Outcome).settled.startsWith("MutationFloorError: "), recorderFails, log.some((call) => call.startsWith("write")), writeFails])
      .toEqual(["ok", true, "EIO: probe refused", false, "EIO: probe refused"]);
  });

  it("A7 makes no ambient disk call in the bound body, while the root form still reaches the disk primitives", async () => {
    const spies = [vi.spyOn(confine, "confineUnderRoot"), vi.spyOn(diskLeaves, "leafPresent"), vi.spyOn(diskLeaves, "readConfinedLeafText"),
      vi.spyOn(diskLeaves, "removeLeaf"), vi.spyOn(diskLeaves, "writeLeafAtomicUnconfined")];
    await runSteps(memorySide([]));
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
    await applyPageMutationLocked(await tracker.create(PREFIX), STEPS[0]!, { recordPreState: async () => undefined });
    expect([spies[0]!, spies[1]!, spies[4]!].map((spy) => spy.mock.calls.length > 0)).toEqual([true, true, true]);
  });
});
