/**
 * Built CLI witnesses exercise streamed output and real candidate admission over
 * local aimock HTTP fixtures; losing the command's print call must fail these.
 */
import { expect, it } from "vitest";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { mockClaudeEnv, useAimockLifecycle, type MockClaudeHandle } from "./fixtures/aimock-helper.js";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import { listCandidates } from "../src/compiler/candidate-read.js";
import { CITED_ANSWER, stageCitationWorkspace, citationWorkspaceBytes } from "./fixtures/query-answer-citations.js";

const aimock = useAimockLifecycle("query-answer-citations");

it.each([false, true])("reports unavailable and preserves the answer with requested save=%s", async (save) => {
  const handle = await aimock.start();
  stubQuery(handle, CITED_ANSWER);
  const root = await workspace();
  const unreadable = path.join(root, "wiki/concepts/unrelated.md");
  await writeFile(unreadable, "---\ntitle: Unrelated\n---\nUnrelated body.\n");
  await chmod(unreadable, 0o000);
  await expect(readFile(unreadable)).rejects.toMatchObject({ code: "EACCES" });
  const args = ["query", "Explain alpha", ...(save ? ["--save"] : [])];
  const result = await runCLI(args, root, { ...mockClaudeEnv(handle), VOYAGE_API_KEY: "" });
  expectCLIExit(result, save ? 1 : 0);
  expect(result.stdout).toContain(CITED_ANSWER);
  expect(result.stderr).toContain("Answer citations: unavailable");
  expect(result.stderr).toContain("EACCES");
  expect(result.stderr).toContain("unrelated.md");
  expect(result.stdout).not.toContain("Answer citations: none recognized");
  expect(result.stdout).not.toContain("Answer citations: 1 resolved");
  expect(await readFile(path.join(root, "log.md"), "utf8")).toContain("query | Explain alpha");
  const savedFile = path.join(root, "wiki/queries/explain-alpha.md");
  await expect(readFile(savedFile)).rejects.toMatchObject({ code: "ENOENT" });
  if (save) {
    expect(result.stdout).toContain("Answer publication refused: citation validation unavailable");
    expect(result.stdout).not.toContain("Tip: use --save");
  }
  expect(handle.mock.getRequests()).toHaveLength(2);
}, 30_000);

/** Register selection and exactly one answer handler on each fresh mock. */
function stubQuery(handle: MockClaudeHandle, answer: string, pages = ["concepts/alpha"]): void {
  handle.mock.onToolCall("select_pages", {
    toolCalls: [{ name: "select_pages", arguments: { pages, reasoning: "Selected alpha" } }],
  });
  handle.mock.onMessage(/.*/, { content: answer });
}

/** Stage a workspace owned and cleaned by the aimock lifecycle. */
async function workspace(): Promise<string> {
  const root = await aimock.makeWorkspace("# Source\n");
  await stageCitationWorkspace(root);
  return root;
}

it("prints exact citation identities after streaming without page/candidate writes or extra requests", async () => {
  const handle = await aimock.start();
  stubQuery(handle, CITED_ANSWER);
  const root = await workspace();
  expect((await listCandidates(root)).map(({ id }) => id)).toEqual(["pending-beta"]);
  const before = await citationWorkspaceBytes(root);
  const result = await runCLI(["query", "Explain alpha"], root, mockClaudeEnv(handle));
  expectCLIExit(result, 0);
  expect(result.stdout).toContain(CITED_ANSWER);
  expect(result.stdout).toContain("Answer citations: 1 resolved, 1 pending, 1 broken");
  expect(result.stdout).toContain("resolved: alpha -> concepts/alpha");
  expect(result.stdout).toContain("pending: beta");
  expect(result.stdout).toContain("broken: missing");
  expect(result.stdout.indexOf("Answer citations:")).toBeGreaterThan(result.stdout.indexOf(CITED_ANSWER));
  expect(await citationWorkspaceBytes(root)).toEqual(before);
  expect(handle.mock.getRequests()).toHaveLength(2);
}, 30_000);

it("prints the no-link caveat rather than implying factual support", async () => {
  const handle = await aimock.start();
  stubQuery(handle, "Plain answer without wikilinks.");
  const result = await runCLI(["query", "Explain alpha"], await workspace(), mockClaudeEnv(handle));
  expectCLIExit(result, 0);
  expect(result.stdout).toContain("Answer citations: none recognized (not a factual-support assessment)");
  expect(handle.mock.getRequests()).toHaveLength(2);
}, 30_000);

it("retains the existing no-match message and skips answer generation for empty selection", async () => {
  const handle = await aimock.start();
  stubQuery(handle, "unused", []);
  const result = await runCLI(["query", "No matches"], await workspace(), mockClaudeEnv(handle));
  expectCLIExit(result, 0);
  expect(result.stdout).toContain("No matching pages found. Try refining your question.");
  expect(result.stdout).not.toContain("Answer citations:");
  expect(handle.mock.getRequests()).toHaveLength(1);
}, 30_000);
