/**
 * @file test/storage/executor-writeone-timing.test.ts
 * @description WHEN the root held-lock executor observes `opts.writeOne`. Before
 * the executor got a bound body it read the option exactly once: after the
 * global replay, after the shape guard, only on the all-page branch, and before
 * the journal batch opened; it then called the writer with no receiver. These
 * cases pin that through the ROOT `applyApprovedMutationsLocked` on real temp
 * projects, with an accessor-backed `opts` that counts its reads and snapshots
 * the journal directory and one page at the moment of each read.
 *
 * The non-page case uses the real relation handler on a project with no
 * profile, which refuses (`deny`) without writing. The replay-failure case makes
 * the journal restore's atomic replace reject once, at its module seam.
 */

import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as diskLeaves from "../../src/storage/disk-guarded-leaves.js";
import { applyApprovedMutationsLocked, type ApplyOptions, type WriteOne } from "../../src/trust/executor.js";
import type { PlannedMutation } from "../../src/trust/planner.js";
import { tempRootTracker } from "../temp-roots.js";
import { writeFiles } from "./copied-project.js";

const PREFIX = "executor-writeone-timing-";
const page = (body: string): string => `---\ntitle: Ok\n---\n\n${body}\n`;
const [OLD, NEW, NEXT] = [page("old"), page("new"), page("next")];
const mutation = (operation: "create" | "update", slug: string, body: string): PlannedMutation =>
  ({ kind: "page", operation, target: { directory: "concepts", slug }, body, provenance: { origin: "agent", decision: "allow", reviewRouted: false } });
const tracker = tempRootTracker();
afterEach(async () => { vi.restoreAllMocks(); await tracker.cleanup(); });

/** A fresh project holding one page, `wiki/concepts/a.md` = OLD. */
async function project(): Promise<string> {
  const root = await tracker.create(PREFIX);
  await writeFiles(root, { "wiki/concepts/a.md": OLD });
  return root;
}

/** The pending journal files at this instant (synchronous: a getter cannot await). */
const journalFiles = (root: string): string[] => {
  try { return readdirSync(path.join(root, ".llmwiki", "journal")).filter((name) => name.endsWith(".json")); } catch { return []; }
};

/** Options whose `writeOne` getter records each read (journal files and a.md at that instant) and yields `writer`. */
function observedOptions(root: string, writer: () => WriteOne): { opts: ApplyOptions; reads: unknown[] } {
  const reads: unknown[] = [];
  const opts = {
    get writeOne(): WriteOne {
      reads.push({ journal: journalFiles(root), a: readFileSync(path.join(root, "wiki/concepts/a.md"), "utf-8") });
      return writer();
    },
  };
  return { opts, reads };
}

/** Leave a pending batch: a.md updated to NEW, then the second write (create b) fails. */
async function leavePending(root: string): Promise<void> {
  let calls = 0;
  const writeOne: WriteOne = async (filePath, content) => {
    calls += 1;
    if (calls === 2) throw new Error("injected write failure");
    return diskLeaves.writeLeafAtomicUnconfined(filePath, content);
  };
  await expect(applyApprovedMutationsLocked(root, [mutation("update", "a", NEW), mutation("create", "b", NEW)], { writeOne }))
    .rejects.toThrow("injected write failure");
  expect([journalFiles(root).length, await readFile(path.join(root, "wiki/concepts/a.md"), "utf-8")]).toEqual([1, NEW]);
}

describe("the root executor observes opts.writeOne once, after replay and the guard, before the batch opens", () => {
  it("T1 never reads it for an empty plan", async () => {
    const root = await project();
    const { opts, reads } = observedOptions(root, () => { throw new Error("not read"); });
    expect([await applyApprovedMutationsLocked(root, [], opts), reads]).toEqual([[], []]);
  });

  it("T2 never reads it for a plan the shape guard refuses", async () => {
    const root = await project();
    const { opts, reads } = observedOptions(root, () => { throw new Error("not read"); });
    await expect(applyApprovedMutationsLocked(root, [mutation("create", "c", NEW), { kind: "relation" } as unknown as PlannedMutation], opts))
      .rejects.toThrow("cross-store-batch-unsupported: mixed-kind batch: page+relation");
    expect(reads).toEqual([]);
  });

  it("T3 never reads it for a lone non-page mutation (the real relation handler refuses without a profile)", async () => {
    const root = await project();
    const { opts, reads } = observedOptions(root, () => { throw new Error("not read"); });
    const relation = { kind: "relation", input: { type: "cites" } } as unknown as PlannedMutation;
    await expect(applyApprovedMutationsLocked(root, [relation], opts)).rejects.toThrow(/relation write of type 'cites' denied/);
    expect(reads).toEqual([]);
  });

  it("T4 reads it exactly once for a page plan, AFTER replay restored the prior batch and BEFORE a new batch opened, and calls it with no receiver", async () => {
    const root = await project();
    await leavePending(root);
    const receivers: unknown[] = [];
    const writer: WriteOne = async function (this: unknown, filePath, content) {
      receivers.push(this);
      return diskLeaves.writeLeafAtomicUnconfined(filePath, content);
    };
    const { opts, reads } = observedOptions(root, () => writer);
    expect(await applyApprovedMutationsLocked(root, [mutation("update", "a", NEXT)], opts)).toEqual([{ kind: "page" }]);
    expect([reads, receivers, journalFiles(root), await readFile(path.join(root, "wiki/concepts/a.md"), "utf-8")])
      .toEqual([[{ journal: [], a: OLD }], [undefined], [], NEXT]);
  });

  it("T5 propagates a throwing getter with no batch opened and nothing written", async () => {
    const root = await project();
    const { opts, reads } = observedOptions(root, () => { throw new Error("getter refused"); });
    await expect(applyApprovedMutationsLocked(root, [mutation("update", "a", NEXT)], opts)).rejects.toThrow("getter refused");
    expect([reads, journalFiles(root), await readFile(path.join(root, "wiki/concepts/a.md"), "utf-8")]).toEqual([[{ journal: [], a: OLD }], [], OLD]);
  });

  it("T6 never reads it when replay itself fails", async () => {
    const root = await project();
    await leavePending(root);
    vi.spyOn(diskLeaves, "replaceLeafAtomicWithin").mockRejectedValueOnce(Object.assign(new Error("EIO: restore refused"), { code: "EIO" }));
    const { opts, reads } = observedOptions(root, () => { throw new Error("not read"); });
    await expect(applyApprovedMutationsLocked(root, [mutation("update", "a", NEXT)], opts)).rejects.toThrow("EIO: restore refused");
    expect([reads, journalFiles(root).length]).toEqual([[], 1]);
  });
});
