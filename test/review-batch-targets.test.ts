/**
 * Portable target collision regressions. Refuse every case/Unicode alias before
 * promotion, on any host filesystem and for both existing and absent targets.
 * Original paths remain unchanged and unrelated namespaces can still proceed.
 */
import { expect, it, vi } from "vitest";
import { readFile, readdir, writeFile } from "fs/promises";
import path from "path";
import { listCandidates } from "../src/compiler/candidates.js";
import * as finalizer from "../src/commands/review-finalize.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { approveBatch, stageBatchCandidate, useQuietBatchTests } from "./fixtures/review-batch.js";

const root = useTempRoot();
useQuietBatchTests();

const aliases = [["Alpha", "alpha"], ["caf\u00e9", "cafe\u0301"], ["\u03c3", "\u03c2"], ["Stra\u00dfe", "STRA\u1e9eE"]];
const cases = aliases.flatMap(([first, second]) => [false, true].flatMap((existing) =>
  [false, true].map((reverse) => ({ first, second, existing, reverse }))));

it.each(cases)("refuses aliases $first/$second (existing=$existing, reverse=$reverse)", async ({ first, second, existing, reverse }) => {
  const target = path.join(root.dir, "wiki/concepts", `${first}.md`);
  const original = "---\ntitle: Original\n---\nUnchanged.\n";
  if (existing) await writeFile(target, original);
  const a = await stageBatchCandidate(root.dir, first);
  const b = await stageBatchCandidate(root.dir, second);
  const finalize = vi.spyOn(finalizer, "finalizeReviewApprovals");
  const ids = reverse ? [b.id, a.id] : [a.id, b.id];
  const result = await approveBatch(root.dir, ...ids);
  expect(result.results.map((item) => item.status)).toEqual(["conflict", "conflict"]);
  expect(result.results.map((item) => item.pagePath)).toEqual(
    (reverse ? [second, first] : [first, second]).map((slug) => `wiki/concepts/${slug}.md`));
  expect(result.finalized).toBe(false);
  expect(finalize).not.toHaveBeenCalled();
  expect((await listCandidates(root.dir)).map((candidate) => candidate.id).sort()).toEqual(ids.sort());
  expect(await readdir(path.join(root.dir, "wiki/concepts"))).toHaveLength(existing ? 1 : 0);
  if (existing) expect(await readFile(target, "utf8")).toBe(original);
});

it("refuses concept aliases while approving the same slug in an unrelated namespace", async () => {
  const a = await stageBatchCandidate(root.dir, "Alpha");
  const b = await stageBatchCandidate(root.dir, "alpha");
  const query = await stageBatchCandidate(root.dir, "alpha", { targetDirectory: "queries" });
  const result = await approveBatch(root.dir, a.id, query.id, b.id);
  expect(result.results.map((item) => item.status)).toEqual(["conflict", "approved", "conflict"]);
  expect(result.status).toBe("partial");
  expect(await readdir(path.join(root.dir, "wiki/concepts"))).toEqual([]);
  expect(await readFile(path.join(root.dir, "wiki/queries/alpha.md"), "utf8")).toContain("Body for alpha.");
  expect((await listCandidates(root.dir)).map((candidate) => candidate.id).sort()).toEqual([a.id, b.id].sort());
});
