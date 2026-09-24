/**
 * Recovery intent is a prerequisite of batch promotion. Corruption, inaccessible
 * storage, and already-known capacity exhaustion fail before live pages or source
 * state change; successful preparation is visible before the executor is entered.
 */
import { expect, it, vi } from "vitest";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import * as executor from "../src/trust/executor.js";
import { readCandidate } from "../src/compiler/candidates.js";
import { writeState } from "../src/utils/state.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { approveBatch, stageBatchCandidate, useQuietBatchTests } from "./fixtures/review-batch.js";

const root = useTempRoot();
const INTENT_FILE = ".llmwiki/review-embedding-intent.json";
const MAX_INTENT_BYTES = 1024 * 1024;
useQuietBatchTests();

it.each(["{malformed", '{"schemaVersion":2,"entries":[]}', "x".repeat(MAX_INTENT_BYTES + 1)])(
  "refuses invalid intent before promotion or source finalization (%#)", async body => {
    const sourceStates = { "source.md": { hash: "new", concepts: [], compiledAt: "before" } };
    const candidate = await stageBatchCandidate(root.dir, "alpha", { sourceStates });
    await writeState(root.dir, { version: 1, indexHash: "", sources: {} });
    const stateFile = path.join(root.dir, ".llmwiki/state.json");
    const before = await readFile(stateFile);
    await writeFile(path.join(root.dir, INTENT_FILE), body);
    const apply = vi.spyOn(executor, "applyApprovedMutationsLocked");
    const result = await approveBatch(root.dir, candidate.id);
    expect(result.status).toBe("failed");
    expect(apply).not.toHaveBeenCalled();
    expect(await readFile(stateFile)).toEqual(before);
    expect(await readFile(path.join(root.dir, INTENT_FILE), "utf8")).toBe(body);
    expect(existsSync(path.join(root.dir, "wiki/concepts/alpha.md"))).toBe(false);
    expect(await readCandidate(root.dir, candidate.id)).not.toBeNull();
  },
);

it.each(["directory", "symlink", "read-only"])("refuses %s intent storage before promotion", async kind => {
  const candidate = await stageBatchCandidate(root.dir, "alpha");
  const file = path.join(root.dir, INTENT_FILE);
  const directory = path.dirname(file);
  if (kind === "directory") await mkdir(file);
  if (kind === "symlink") {
    const sentinel = path.join(root.dir, "sentinel.json");
    await writeFile(sentinel, "untouched");
    await symlink(sentinel, file);
  }
  if (kind === "read-only") await chmod(directory, 0o555);
  try {
    const result = await approveBatch(root.dir, candidate.id);
    expect(result.status).toBe("failed");
    expect(existsSync(path.join(root.dir, "wiki/concepts/alpha.md"))).toBe(false);
    expect(await readCandidate(root.dir, candidate.id)).not.toBeNull();
    if (kind === "symlink") expect(await readFile(path.join(root.dir, "sentinel.json"), "utf8")).toBe("untouched");
  } finally {
    if (kind === "read-only") await chmod(directory, 0o755);
  }
});

it("checks capacity of the initial known work before promoting a page", async () => {
  const candidate = await stageBatchCandidate(root.dir, "alpha");
  const entry = { candidates: ["a".repeat(64)], pageIds: ["concepts/padding"] };
  const initial = JSON.stringify({ schemaVersion: 1, entries: [entry] });
  entry.pageIds[0] += "x".repeat(MAX_INTENT_BYTES - Buffer.byteLength(initial));
  const before = JSON.stringify({ schemaVersion: 1, entries: [entry] });
  await writeFile(path.join(root.dir, INTENT_FILE), before);
  const result = await approveBatch(root.dir, candidate.id);
  expect(result.status).toBe("failed");
  expect(result.error).toContain("exceeds 1 MiB");
  expect(existsSync(path.join(root.dir, "wiki/concepts/alpha.md"))).toBe(false);
  expect(await readFile(path.join(root.dir, INTENT_FILE), "utf8")).toBe(before);
  expect(await readCandidate(root.dir, candidate.id)).not.toBeNull();
});

it("persists the candidate page intent under lock before the first page promotion", async () => {
  const candidate = await stageBatchCandidate(root.dir, "alpha");
  const apply = executor.applyApprovedMutationsLocked;
  vi.spyOn(executor, "applyApprovedMutationsLocked").mockImplementationOnce(async (dir, plan) => {
    expect(existsSync(path.join(dir, ".llmwiki/lock"))).toBe(true);
    expect(await readFile(path.join(dir, INTENT_FILE), "utf8")).toContain("concepts/alpha");
    expect(existsSync(path.join(dir, "wiki/concepts/alpha.md"))).toBe(false);
    return apply(dir, plan);
  });
  expect((await approveBatch(root.dir, candidate.id)).status).toBe("completed");
});

it("does not open intent storage when no candidate is approvable", async () => {
  const candidate = await stageBatchCandidate(root.dir, "invalid", { body: "no frontmatter" });
  await writeFile(path.join(root.dir, INTENT_FILE), "{malformed");
  const result = await approveBatch(root.dir, candidate.id);
  expect(result.status).toBe("partial");
  expect(result.finalized).toBe(false);
  expect(await readFile(path.join(root.dir, INTENT_FILE), "utf8")).toBe("{malformed");
});
