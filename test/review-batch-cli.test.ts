/**
 * Exercise batch approval through the packaged CLI, including JSON-only output,
 * partial refusals, duplicate targets and the inherited single-review commands.
 * Fixtures contain no provider credentials and disable local embeddings.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ReviewBatchItem, ReviewBatchResult } from "../src/commands/review-batch-types.js";
import { expectCLIExit, runCLI } from "./fixtures/run-cli.js";

const FIXTURE_DATE = "2026-09-17T00:00:00.000Z";
const CLI_ENV = { LLMWIKI_EMBEDDINGS: "off", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" };
let root: string;

/** Build a valid body with references that exercise the shared resolver. */
function page(title: string): string {
  return `---\ntitle: "${title}"\nsummary: "Shared knowledge"\nsources: []\ncreatedAt: "${FIXTURE_DATE}"\nupdatedAt: "${FIXTURE_DATE}"\n---\n\n# ${title}\n\nAlpha topic relates to Beta topic and Existing topic.\n`;
}

/** Write one candidate without invoking the compiler or any model. */
async function candidate(id: string, slug: string, title: string): Promise<string> {
  const body = page(title);
  await writeFile(path.join(root, ".llmwiki/candidates", `${id}.json`), JSON.stringify({
    id, slug, title, summary: "Shared knowledge", sources: [], body,
    generatedAt: FIXTURE_DATE, reviewMode: "forced",
    heldReasons: [{ code: "manual-review-requested" }],
  }));
  return body;
}

/** Pass a real manifest to Commander and require a single parseable JSON envelope. */
async function approve(items: ReviewBatchItem[], exitCode = 0): Promise<ReviewBatchResult> {
  await writeFile(path.join(root, "approval.json"), JSON.stringify({ schemaVersion: 1, candidates: items }));
  const run = await runCLI(["review", "approve-batch", "--input", "approval.json", "--json"], root, CLI_ENV);
  expectCLIExit(run, exitCode);
  const result = JSON.parse(run.stdout) as ReviewBatchResult;
  expect(result.schemaVersion).toBe(1);
  expect(result.timingsMs.total).toBeGreaterThanOrEqual(0);
  return result;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "llmwiki-batch-cli-"));
  await mkdir(path.join(root, ".llmwiki/candidates"), { recursive: true });
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await mkdir(path.join(root, "sources"), { recursive: true });
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("publishes both pages and preserves links to existing and batch-new targets", async () => {
    await writeFile(path.join(root, "wiki/concepts/existing-topic.md"), page("Existing topic"));
    await candidate("alpha-aaaaaaaa", "alpha-topic", "Alpha topic");
    await candidate("beta-bbbbbbbb", "beta-topic", "Beta topic");
    const result = await approve([{ id: "alpha-aaaaaaaa" }, { id: "beta-bbbbbbbb" }]);
    expect(result).toMatchObject({ status: "completed", finalized: true });
    expect(result.results.map(item => item.status)).toEqual(["approved", "approved"]);
    const alpha = await readFile(path.join(root, "wiki/concepts/alpha-topic.md"), "utf8");
    expect(alpha).toContain("[[beta-topic");
    expect(alpha).toContain("[[existing-topic");
    expect(await readFile(path.join(root, "wiki/index.md"), "utf8")).toContain("alpha-topic");
    expect(await readdir(path.join(root, ".llmwiki/candidates"))).toEqual([]);
  });

  it("reports a missing candidate without preventing valid approval", async () => {
    await candidate("alpha-aaaaaaaa", "alpha-topic", "Alpha topic");
    const result = await approve([{ id: "missing-cccccccc" }, { id: "alpha-aaaaaaaa" }], 1);
    expect(result).toMatchObject({ status: "partial", finalized: true });
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "missing-cccccccc", status: "invalid" }),
      expect.objectContaining({ id: "alpha-aaaaaaaa", status: "approved" }),
    ]));
  });

  it("deduplicates identical IDs while rejecting all distinct candidates for one target", async () => {
    await candidate("alpha-aaaaaaaa", "alpha-topic", "Alpha topic");
    await candidate("other-bbbbbbbb", "alpha-topic", "Other proposal");
    const result = await approve([
      { id: "alpha-aaaaaaaa" }, { id: "alpha-aaaaaaaa" }, { id: "other-bbbbbbbb" },
    ], 1);
    expect(result).toMatchObject({ status: "partial", finalized: false });
    expect(result.results.map(item => item.status)).toEqual(["conflict", "conflict"]);
    expect(await readdir(path.join(root, "wiki/concepts"))).toEqual([]);
    expect(await readdir(path.join(root, ".llmwiki/candidates"))).toHaveLength(2);
  });

  it("binds supplied hashes for ordinary candidates and keeps stale candidates pending", async () => {
    const body = await candidate("alpha-aaaaaaaa", "alpha-topic", "Alpha topic");
    const stale = await approve([{ id: "alpha-aaaaaaaa", draftContentHash: "0".repeat(64) }], 1);
    expect(stale).toMatchObject({ finalized: false, results: [{ status: "invalid" }] });
    const current = await approve([{ id: "alpha-aaaaaaaa", draftContentHash: createHash("sha256").update(body).digest("hex") }]);
    expect(current).toMatchObject({ finalized: true, results: [{ status: "approved" }] });
  });

  it("returns a structured failure for malformed input without changing any candidate", async () => {
    await candidate("alpha-aaaaaaaa", "alpha-topic", "Alpha topic");
    await writeFile(path.join(root, "approval.json"), "{broken");
    const run = await runCLI(["review", "approve-batch", "--input", "approval.json", "--json"], root, CLI_ENV);
    expectCLIExit(run, 1);
    expect(JSON.parse(run.stdout)).toMatchObject({ status: "failed", finalized: false });
    expect(await readdir(path.join(root, ".llmwiki/candidates"))).toEqual(["alpha-aaaaaaaa.json"]);
  });

  it("keeps single approval and rejection available after the finalizer extraction", async () => {
    await candidate("alpha-aaaaaaaa", "alpha-topic", "Alpha topic");
    await candidate("beta-bbbbbbbb", "beta-topic", "Beta topic");
    expectCLIExit(await runCLI(["review", "approve", "alpha-aaaaaaaa"], root, CLI_ENV), 0);
    expectCLIExit(await runCLI(["review", "reject", "beta-bbbbbbbb"], root, CLI_ENV), 0);
    expect(await readdir(path.join(root, "wiki/concepts"))).toEqual(["alpha-topic.md"]);
  });
