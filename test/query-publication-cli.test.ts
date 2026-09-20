/**
 * Publication through the built CLI with local deterministic HTTP responses.
 * Every query makes exactly selection + generation calls; validation and review
 * add none. Embedding refresh is explicitly disabled to avoid external traffic.
 */
import { expect, it } from "vitest";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { useAimockLifecycle, mockClaudeEnv, type MockClaudeHandle } from "./fixtures/aimock-helper.js";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import { stageCitationWorkspace, citationWorkspaceBytes } from "./fixtures/query-answer-citations.js";
import { SAMPLE_PROFILE } from "./fixtures/profile-fixtures.js";
import { listCandidates } from "../src/compiler/candidate-read.js";
import { buildQueryDocument } from "../src/commands/query-document.js";

const aimock = useAimockLifecycle("query-publication-cli");

/** Seed real pages and one pending concept, with all provider traffic local. */
async function setup(answer: string) {
  const root = await aimock.makeWorkspace("# Source\n");
  await stageCitationWorkspace(root);
  const handle = await aimock.start();
  handle.mock.onToolCall("select_pages", {
    toolCalls: [{ name: "select_pages", arguments: { pages: ["concepts/alpha"], reasoning: "Alpha" } }],
  });
  handle.mock.onMessage(/.*/, { content: answer });
  const env = { ...mockClaudeEnv(handle), VOYAGE_API_KEY: "", LLMWIKI_EMBEDDINGS: "off",
    ANTHROPIC_AUTH_TOKEN: "", LLMWIKI_CLAUDE_SETTINGS_PATH: path.join(root, "no-settings.json") };
  return { root, handle, env };
}

type SaveRun = { root: string; handle: MockClaudeHandle; result: Awaited<ReturnType<typeof runCLI>>; before: Record<string, Buffer>; index: Buffer };

/** Run one built-CLI `query --save` (plus extra flags), optionally under a sample profile. */
async function runSave(answer: string, extra: string[], profile = false): Promise<SaveRun> {
  const { root, handle, env } = await setup(answer);
  if (profile) await writeFile(path.join(root, ".llmwiki/profile.json"), JSON.stringify(SAMPLE_PROFILE));
  const before = await citationWorkspaceBytes(root);
  const index = await readFile(path.join(root, "wiki/index.md"));
  const result = await runCLI(["query", "Explain alpha", "--save", ...extra], root, env);
  expect(result.stdout).not.toContain("Tip: use --save");
  return { root, handle, result, before, index };
}

/** Assert a reviewed answer was staged, not published, with no extra provider request. */
async function expectStaged({ root, handle, result }: SaveRun) {
  expectCLIExit(result, 0);
  const candidate = (await listCandidates(root)).find((entry) => entry.candidateKind);
  expect(candidate).toBeDefined();
  expect(result.stdout).toContain(`Staged answer for review: ${candidate!.id}`);
  await expect(readFile(path.join(root, "wiki/queries/explain-alpha.md"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(handle.mock.getRequests()).toHaveLength(2);
  return candidate!;
}

it("rejects review without save before credential preflight or generation", async () => {
  const { root, handle, env } = await setup("unused");
  const result = await runCLI(["query", "Explain alpha", "--review"], root, { ...env, ANTHROPIC_API_KEY: "" });
  expectCLIExit(result, 1);
  expect(result.stderr).toContain("Query review requires save.");
  expect(result.stderr).not.toContain("ANTHROPIC_API_KEY");
  expect(handle.mock.getRequests()).toHaveLength(0);
});

it.each(["Retained [[alpha]].", "No recognized links."])("publishes an eligible direct answer: %s", async (answer) => {
  const { root, handle, result } = await runSave(answer, []);
  expectCLIExit(result, 0);
  expect(result.stdout).toContain(answer);
  expect(result.stdout).toContain("Saved. Future queries");
  expect(await readFile(path.join(root, "wiki/queries/explain-alpha.md"), "utf8")).toContain(answer);
  expect((await listCandidates(root)).map((candidate) => candidate.id)).toEqual(["pending-beta"]);
  expect(handle.mock.getRequests()).toHaveLength(2);
});

it.each([
  { answer: "Pending [[beta]].", review: false, code: "pending" },
  { answer: "Broken [[missing]].", review: false, code: "broken" },
  { answer: "Both [[beta]] [[missing]].", review: false, code: "broken" },
  { answer: "Broken [[missing]].", review: true, code: "broken" },
])("displays and refuses $code citations with review=$review: $answer", async ({ answer, review, code }) => {
  const { root, handle, result, before, index } = await runSave(answer, review ? ["--review"] : []);
  expectCLIExit(result, 1);
  expect(result.stdout).toContain(answer);
  expect(result.stdout).toContain(`Answer publication refused: ${code} citation targets:`);
  if (answer.startsWith("Both")) expect(result.stdout).toContain("broken citation targets: missing; pending citation targets: beta");
  expect(await citationWorkspaceBytes(root)).toEqual(before);
  expect(await readFile(path.join(root, "wiki/index.md"))).toEqual(index);
  expect(handle.mock.getRequests()).toHaveLength(2);
});

it("stages pending links, refuses approval, then approves after publishing the target", async () => {
  const answer = "Pending [[beta]].";
  const { root, handle, env } = await setup(answer);
  const targetPath = path.join(root, ".llmwiki/candidates/pending-beta.json");
  const target = JSON.parse(await readFile(targetPath, "utf8"));
  target.body = buildQueryDocument("Beta", "Beta body.", "2026-09-19T00:00:00Z").document;
  await writeFile(targetPath, JSON.stringify(target));
  const index = await readFile(path.join(root, "wiki/index.md"));
  const staged = await runCLI(["query", "Explain alpha", "--save", "--review"], root, env);
  const candidate = await expectStaged({ root, handle, result: staged, before: {}, index });
  expect(staged.stdout).not.toContain("Tip: use --save");
  expect(await readFile(path.join(root, "wiki/index.md"))).toEqual(index);
  const candidatePath = path.join(root, `.llmwiki/candidates/${candidate!.id}.json`);
  const bytes = await readFile(candidatePath);
  expectCLIExit(await runCLI(["review", "approve", candidate!.id], root, env), 1);
  expect(await readFile(candidatePath)).toEqual(bytes);
  expectCLIExit(await runCLI(["review", "approve", "pending-beta"], root, env), 0);
  expectCLIExit(await runCLI(["review", "approve", candidate!.id], root, env), 0);
  expect(await readFile(path.join(root, "wiki/queries/explain-alpha.md"), "utf8")).toBe(candidate!.body);
  expect(await listCandidates(root)).toEqual([]);
  expect(handle.mock.getRequests()).toHaveLength(2);
}, 30_000);

it.each(["Retained [[alpha]].", "No recognized links."])("stages an eligible answer without publishing: %s", async (answer) => {
  const run = await runSave(answer, ["--review"]);
  await expectStaged(run);
  expect(run.result.stdout).toContain(answer);
});

it("keeps the direct-save profile refusal at exit zero", async () => {
  const answer = "Retained [[alpha]].";
  const { root, handle, result, before } = await runSave(answer, [], true);
  expectCLIExit(result, 0);
  expect(result.stdout).toContain(answer);
  expect(result.stdout).toContain("query --save is disabled in profile-enabled projects");
  expect(await citationWorkspaceBytes(root)).toEqual(before);
  expect(handle.mock.getRequests()).toHaveLength(2);
});

it("stages a reviewed answer in a profile-enabled project without publishing", async () => {
  const run = await runSave("Retained [[alpha]].", ["--review"], true);
  await expectStaged(run);
  expect(run.result.stdout).not.toContain("query --save is disabled");
});

it("preserves the displayed answer when reviewed staging validation is unavailable", async () => {
  const answer = "Retained [[alpha]].";
  const { root, handle, env } = await setup(answer);
  const unreadable = path.join(root, "wiki/concepts/unrelated.md");
  await writeFile(unreadable, "---\ntitle: Unrelated\n---\nBody.");
  const before = await citationWorkspaceBytes(root);
  await chmod(unreadable, 0o000);
  const result = await runCLI(["query", "Explain alpha", "--save", "--review"], root, env);
  expectCLIExit(result, 1);
  expect(result.stdout).toContain(answer);
  expect(result.stdout).toContain("Answer publication refused: citation validation unavailable");
  expect(result.stdout).not.toContain("Tip: use --save");
  await chmod(unreadable, 0o644);
  expect(await citationWorkspaceBytes(root)).toEqual(before);
  expect(handle.mock.getRequests()).toHaveLength(2);
});
