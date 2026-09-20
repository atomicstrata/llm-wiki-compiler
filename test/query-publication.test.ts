/**
 * Direct publication witnesses pin no-write refusals, exact canonical bytes,
 * mandatory fresh resolution and failures outside the citation recovery scope.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { maybeSaveQueryPage } from "../src/commands/query-publication.js";
import { updateEmbeddingsLockedCore } from "../src/utils/embeddings.js";
import { buildQueryDocument } from "../src/commands/query-document.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { stageCitationWorkspace } from "./fixtures/query-answer-citations.js";

vi.mock("../src/utils/embeddings.js", async (original) => ({
  ...await original<typeof import("../src/utils/embeddings.js")>(),
  updateEmbeddingsLockedCore: vi.fn().mockResolvedValue(undefined),
}));
const ctx = useTempRoot();
beforeEach(async () => {
  await stageCitationWorkspace(ctx.dir);
  await writeFile(path.join(ctx.dir, ".llmwiki/embeddings.json"), "sentinel embeddings");
  vi.mocked(updateEmbeddingsLockedCore).mockClear();
});
afterEach(() => vi.unstubAllEnvs());

/** Snapshot every publication surface, including nested index/embedding artifacts. */
async function snapshot(): Promise<Record<string, Buffer>> {
  const bytes: Record<string, Buffer> = {};
  for (const dir of ["wiki", ".llmwiki"]) {
    for (const entry of await readdir(path.join(ctx.dir, dir), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || entry.name === "lock" || entry.name === "lock.reclaim") continue;
      const file = path.join(entry.parentPath, entry.name);
      bytes[path.relative(ctx.dir, file)] = await readFile(file);
    }
  }
  return bytes;
}

it.each([["[[BETA]] [[beta]]", "pending", "beta"], ["[[Gone]]", "broken", "gone"]])(
  "refuses %s without page, candidate, index or embedding writes", async (answer, code, target) => {
    const before = await snapshot();
    const result = await maybeSaveQueryPage({ root: ctx.dir, question: "Explain alpha", answer, save: true });
    expect(result).toMatchObject({ publicationRefusal: { code, targets: [target] } });
    expect(result.saved).toBeUndefined();
    expect(await snapshot()).toEqual(before);
    expect(updateEmbeddingsLockedCore).not.toHaveBeenCalled();
  },
);

it("writes the exact validated document and refreshes index and embeddings", async () => {
  const document = buildQueryDocument("Explain alpha", "[[Alpha]]\r\n", "2026-09-19T00:00:00Z").document;
  const result = await maybeSaveQueryPage({ root: ctx.dir, question: "Explain alpha", answer: "unused", save: true, document });
  expect(result).toEqual({ saved: "explain-alpha" });
  expect(await readFile(path.join(ctx.dir, "wiki/queries/explain-alpha.md"), "utf8")).toBe(document);
  expect(await readFile(path.join(ctx.dir, "wiki/index.md"), "utf8")).toContain("explain-alpha");
  expect(updateEmbeddingsLockedCore).toHaveBeenCalledWith(ctx.dir, ["queries/explain-alpha"]);
});

it("propagates a real atomic write failure instead of reporting unavailable", async () => {
  await mkdir(path.join(ctx.dir, "wiki/queries/explain-alpha.md"));
  await expect(maybeSaveQueryPage({ root: ctx.dir, question: "Explain alpha", answer: "[[Alpha]]", save: true }))
    .rejects.toMatchObject({ code: "EISDIR" });
  expect(updateEmbeddingsLockedCore).not.toHaveBeenCalled();
});
