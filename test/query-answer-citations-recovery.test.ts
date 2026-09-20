/**
 * Query recovery witnesses use real unreadable unrelated pages and real saves.
 * Only the LLM provider is mocked: strict collection, retrieval, persistence,
 * activity logging, and SDK quiet scopes all exercise production code.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createWiki } from "../src/index.js";
import { generateAnswer } from "../src/commands/query.js";
import { reportAnswerCitations } from "../src/citations/answer-report.js";
import { callClaude } from "../src/utils/llm.js";
import * as activityLog from "../src/utils/activity-log.js";
import { setQuerySaveTestHookForTest } from "../src/commands/query-publication.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { stageCitationWorkspace, citationWorkspaceBytes } from "./fixtures/query-answer-citations.js";

vi.mock("../src/utils/llm.js", () => ({ callClaude: vi.fn() }));
const ctx = useTempRoot();
const ANSWER = "The answer cites [[Alpha]].";
beforeEach(async () => {
  vi.stubEnv("LLMWIKI_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "offline-test-key");
  vi.stubEnv("VOYAGE_API_KEY", "");
  await stageCitationWorkspace(ctx.dir);
  vi.mocked(callClaude).mockReset().mockImplementation(async (options) => {
    if (options.tools) return JSON.stringify({ pages: ["concepts/alpha"], reasoning: "Selected alpha" });
    options.onToken?.(ANSWER);
    return ANSWER;
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  setQuerySaveTestHookForTest(undefined);
});

/** Prove a real permission failure before exercising the query boundary. */
async function unreadablePage(): Promise<string> {
  const file = path.join(ctx.dir, "wiki/concepts/unrelated.md");
  await writeFile(file, "---\ntitle: Unrelated\n---\nUnrelated body.\n");
  await chmod(file, 0o000);
  await expect(readFile(file)).rejects.toMatchObject({ code: "EACCES" });
  return file;
}

it("preserves the paid answer and log but refuses saving when authoritative collection is unavailable", async () => {
  const file = await unreadablePage();
  await chmod(file, 0o644);
  const before = await citationWorkspaceBytes(ctx.dir);
  const indexBefore = await readFile(path.join(ctx.dir, "wiki/index.md"));
  const embeddings = path.join(ctx.dir, ".llmwiki/embeddings.json");
  await writeFile(embeddings, "sentinel embeddings");
  await chmod(file, 0o000);
  await expect(reportAnswerCitations(ctx.dir, ANSWER)).rejects.toMatchObject({ code: "EACCES" });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const result = await createWiki({ root: ctx.dir }).query("Explain alpha", { save: true });
  expect(result.answer).toBe(ANSWER);
  expect(result.pageIds).toEqual(["concepts/alpha"]);
  expect(result).not.toHaveProperty("answerCitations");
  expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty("answerCitations");
  expect(result.saved).toBeUndefined();
  expect(result.publicationRefusal).toMatchObject({ code: "unavailable", targets: [] });
  await expect(readFile(path.join(ctx.dir, "wiki/queries/explain-alpha.md"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(ctx.dir, "log.md"), "utf8")).toContain("query | Explain alpha\n- Pages: [[concepts/alpha]]");
  expect(callClaude).toHaveBeenCalledTimes(2);
  expect(log).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  await chmod(file, 0o644);
  expect(await citationWorkspaceBytes(ctx.dir)).toEqual(before);
  expect(await readFile(path.join(ctx.dir, "wiki/index.md"))).toEqual(indexBefore);
  expect(await readFile(embeddings, "utf8")).toBe("sentinel embeddings");
});

it("saves when advisory reporting fails but authoritative validation succeeds", async () => {
  const file = await unreadablePage();
  setQuerySaveTestHookForTest(() => chmod(file, 0o644));
  const result = await createWiki({ root: ctx.dir }).query("Explain alpha", { save: true });
  expect(result.answer).toBe(ANSWER);
  expect(result).not.toHaveProperty("answerCitations");
  expect(result).not.toHaveProperty("publicationRefusal");
  expect(result.saved).toBe("explain-alpha");
  expect(await readFile(path.join(ctx.dir, "wiki/queries/explain-alpha.md"), "utf8")).toContain(ANSWER);
  expect(callClaude).toHaveBeenCalledTimes(2);
});

it("returns unavailable quietly without saving or changing page/candidate bytes", async () => {
  const file = await unreadablePage();
  await chmod(file, 0o644);
  const before = await citationWorkspaceBytes(ctx.dir);
  await chmod(file, 0o000);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const result = await createWiki({ root: ctx.dir }).query("Explain alpha");
  expect(result.answer).toBe(ANSWER);
  expect(result).not.toHaveProperty("answerCitations");
  expect(result.saved).toBeUndefined();
  await chmod(file, 0o644);
  expect(await citationWorkspaceBytes(ctx.dir)).toEqual(before);
  expect(await readFile(path.join(ctx.dir, "log.md"), "utf8")).toContain("query | Explain alpha");
  expect(callClaude).toHaveBeenCalledTimes(2);
  expect(log).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

it("distinguishes successful no-link collection from unavailable no-link collection", async () => {
  vi.mocked(callClaude).mockImplementation(async (options) => options.tools
    ? JSON.stringify({ pages: ["concepts/alpha"], reasoning: "Selected alpha" }) : "Plain answer.");
  const wiki = createWiki({ root: ctx.dir });
  expect((await wiki.query("Explain alpha")).answerCitations).toEqual({ version: 1, citations: [] });
  await unreadablePage();
  const result = await wiki.query("Explain alpha");
  expect(result.answer).toBe("Plain answer.");
  expect(result).not.toHaveProperty("answerCitations");
  expect(callClaude).toHaveBeenCalledTimes(4);
});

it("propagates real save failures even after recovering a citation failure", async () => {
  const file = await unreadablePage();
  setQuerySaveTestHookForTest(() => chmod(file, 0o644));
  const target = path.join(ctx.dir, "wiki/queries/explain-alpha.md");
  await mkdir(target);
  await expect(createWiki({ root: ctx.dir }).query("Explain alpha", { save: true }))
    .rejects.toMatchObject({ code: "EISDIR" });
  expect(callClaude).toHaveBeenCalledTimes(2);
  await expect(readFile(path.join(ctx.dir, "log.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("propagates generation failure before collection, saving, or logging", async () => {
  await unreadablePage();
  const failure = new Error("provider generation failed");
  vi.mocked(callClaude).mockImplementation(async (options) => {
    if (options.tools) return JSON.stringify({ pages: ["concepts/alpha"], reasoning: "Selected alpha" });
    throw failure;
  });
  await expect(createWiki({ root: ctx.dir }).query("Explain alpha", { save: true })).rejects.toBe(failure);
  await expect(readFile(path.join(ctx.dir, "wiki/queries/explain-alpha.md"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(path.join(ctx.dir, "log.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves the existing warning-only behavior of real activity-log write failure", async () => {
  await unreadablePage();
  await mkdir(path.join(ctx.dir, "log.md"));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const result = await generateAnswer(ctx.dir, "Explain alpha", { save: true });
  expect(result.answer).toBe(ANSWER);
  expect(result.publicationRefusal?.code).toBe("unavailable");
  expect(log.mock.calls.flat().join(" ")).toContain("Skipped log.md update:");
  await expect(readFile(path.join(ctx.dir, "wiki/queries/explain-alpha.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("propagates an error escaping the activity-log boundary without turning it into refusal", async () => {
  const failure = new Error("activity-log boundary failure");
  vi.spyOn(activityLog, "appendLog").mockRejectedValueOnce(failure);
  await expect(createWiki({ root: ctx.dir }).query("Explain alpha")).rejects.toBe(failure);
});
