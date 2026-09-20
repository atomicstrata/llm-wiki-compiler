/**
 * Query pipeline race witnesses pause at the existing under-lock save seam.
 * Only provider generation is mocked; advisory reporting, fresh authoritative
 * resolution, persistence, and activity logging exercise production code.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateAnswer } from "../src/commands/query.js";
import { setQuerySaveTestHookForTest } from "../src/commands/query-publication.js";
import { callClaude } from "../src/utils/llm.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { stageCitationWorkspace, citationWorkspaceBytes } from "./fixtures/query-answer-citations.js";

vi.mock("../src/utils/llm.js", () => ({ callClaude: vi.fn() }));
const ctx = useTempRoot();
const ANSWER = "The answer cites [[Target]].";
beforeEach(async () => {
  vi.stubEnv("VOYAGE_API_KEY", "");
  await stageCitationWorkspace(ctx.dir);
  vi.mocked(callClaude).mockReset().mockImplementation(async (options) => options.tools
    ? JSON.stringify({ pages: ["concepts/alpha"], reasoning: "Selected alpha" }) : ANSWER);
});
afterEach(() => {
  vi.unstubAllEnvs();
  setQuerySaveTestHookForTest(undefined);
});

it.each(["deletion", "alias removal"])("fresh under-lock resolution refuses after target %s", async (change) => {
  const target = path.join(ctx.dir, `wiki/concepts/${change === "deletion" ? "target" : "other"}.md`);
  await writeFile(target, "---\naliases: [Target]\n---\nTarget body.");
  let before: Record<string, Buffer> = {};
  let indexBefore = "";
  setQuerySaveTestHookForTest(async () => {
    const acquired = await acquireLock(ctx.dir, { quiet: true });
    if (acquired) await releaseLock(ctx.dir);
    expect(acquired).toBe(false);
    if (change === "deletion") await unlink(target);
    else await writeFile(target, "---\naliases: [Changed]\n---\nTarget body.");
    before = await citationWorkspaceBytes(ctx.dir);
    indexBefore = await readFile(path.join(ctx.dir, "wiki/index.md"), "utf8");
  });
  const result = await generateAnswer(ctx.dir, "Explain alpha", { save: true });
  expect(result.answerCitations?.citations[0].status).toBe("resolved");
  expect(result.answer).toBe(ANSWER);
  expect(result.publicationRefusal).toMatchObject({ code: "broken", targets: ["target"] });
  expect(result.saved).toBeUndefined();
  expect(await citationWorkspaceBytes(ctx.dir)).toEqual(before);
  expect(await readFile(path.join(ctx.dir, "wiki/index.md"), "utf8")).toBe(indexBefore);
  expect(await readFile(path.join(ctx.dir, "log.md"), "utf8")).toContain("query | Explain alpha");
  expect(callClaude).toHaveBeenCalledTimes(2);
});
