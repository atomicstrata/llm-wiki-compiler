/**
 * Batch approval shares single approval's under-lock destination preconditions.
 * Real proposals and destinations exercise stale repair refusal, namespace
 * routing, fail-closed reads, and retries after a partial finalization.
 */
import { expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { lintFixProposeCommand } from "../src/commands/lint-fix-propose.js";
import { listCandidates, readCandidate } from "../src/compiler/candidates.js";
import { sha256Text } from "../src/connectors/hash.js";
import * as indexgen from "../src/compiler/indexgen.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { buildResearchLiteProject } from "./fixtures/profile-fixtures.js";
import { approveBatch, stageBatchCandidate, useQuietBatchTests } from "./fixtures/review-batch.js";

const root = useTempRoot();
const ORIGINAL = "---\ntitle: Target\n---\nOriginal text.\n";
const EDITED = "---\ntitle: Target\n---\nAn edit made after proposal.\n";
useQuietBatchTests();

it("preserves a live edit after lint --fix-propose while approving an unrelated candidate", async () => {
  const target = path.join(root.dir, "wiki/concepts/linker.md");
  await writeFile(path.join(root.dir, "wiki/concepts/sdpa.md"), '---\ntitle: Scaled Dot-Product Attention\n---\nBody.\n');
  await writeFile(target, '---\ntitle: Linker\n---\nUses [[Scaled Dot-Product Attention]].\n');
  expect(await lintFixProposeCommand(1)).toBe(0);
  const [repair] = await listCandidates(root.dir);
  const candidateFile = path.join(root.dir, ".llmwiki/candidates", `${repair.id}.json`);
  const before = await readFile(candidateFile);
  await writeFile(target, EDITED);
  const unrelated = await stageBatchCandidate(root.dir, "unrelated");
  const result = await approveBatch(root.dir, repair.id, unrelated.id);
  expect(result.results.map(item => item.status)).toEqual(["invalid", "approved"]);
  expect(result.results[0].error).toContain("Target page changed");
  expect(await readFile(target, "utf8")).toBe(EDITED);
  expect(await readFile(candidateFile)).toEqual(before);
});

it.each(["concepts", "queries", "experiments"] as const)("checks the exact %s destination before overwrite", async namespace => {
  if (namespace === "experiments") await buildResearchLiteProject(root.dir);
  await mkdir(path.join(root.dir, "wiki", namespace), { recursive: true });
  const target = path.join(root.dir, "wiki", namespace, "target.md");
  await writeFile(target, EDITED);
  const candidate = await stageBatchCandidate(root.dir, "target", {
    expectedTargetHash: sha256Text(ORIGINAL),
    ...(namespace === "experiments" ? { targetEntityType: namespace } : { targetDirectory: namespace }),
  });
  const result = await approveBatch(root.dir, candidate.id);
  expect(result.results[0].status).toBe("invalid");
  expect(await readFile(target, "utf8")).toBe(EDITED);
  expect(await readCandidate(root.dir, candidate.id)).not.toBeNull();
});

it.each(["appeared", "removed", "unreadable", "contradictory"])("refuses a %s destination precondition", async kind => {
  const target = path.join(root.dir, "wiki/concepts/target.md");
  if (kind === "appeared") await writeFile(target, EDITED);
  if (kind === "unreadable") await mkdir(target);
  const candidate = await stageBatchCandidate(root.dir, "target", {
    ...(kind !== "appeared" ? { expectedTargetHash: sha256Text(ORIGINAL) } : {}),
    ...(kind === "appeared" || kind === "contradictory" ? { expectTargetAbsent: true } : {}),
  });
  const result = await approveBatch(root.dir, candidate.id);
  expect(result.results[0].status).toBe("invalid");
  expect(result.finalized).toBe(false);
  expect(await readCandidate(root.dir, candidate.id)).not.toBeNull();
  if (kind === "appeared") expect(await readFile(target, "utf8")).toBe(EDITED);
});

it.each(["hash", "absence"])("approves while the %s precondition still holds", async kind => {
  const target = path.join(root.dir, "wiki/concepts/target.md");
  if (kind === "hash") await writeFile(target, ORIGINAL);
  const candidate = await stageBatchCandidate(root.dir, "target", kind === "hash"
    ? { expectedTargetHash: sha256Text(ORIGINAL) } : { expectTargetAbsent: true });
  expect((await approveBatch(root.dir, candidate.id)).status).toBe("completed");
  expect(await readFile(target, "utf8")).toBe(candidate.body);
});

it("does not bypass destination preconditions on retry after a promoted page's finalization failed", async () => {
  const candidate = await stageBatchCandidate(root.dir, "target", { expectTargetAbsent: true });
  vi.spyOn(indexgen, "generateIndex").mockRejectedValueOnce(new Error("index failed"));
  expect((await approveBatch(root.dir, candidate.id)).status).toBe("failed");
  const retry = await approveBatch(root.dir, candidate.id);
  expect(retry.results[0].status).toBe("invalid");
  expect(await readFile(path.join(root.dir, "wiki/concepts/target.md"), "utf8")).toBe(candidate.body);
  expect(await readCandidate(root.dir, candidate.id)).not.toBeNull();
});
