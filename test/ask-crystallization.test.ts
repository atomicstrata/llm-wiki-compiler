/**
 * @file test/ask-crystallization.test.ts
 * @description AS-1R "ask crystallization": `query --save --review` proposes the
 * answer as a review candidate instead of writing `wiki/queries/` directly.
 *
 * Driven through the REAL generateAnswer pipeline (the entry the CLI calls) with
 * an echo model, so the claim covers the path an operator exercises, not a
 * stand-in. The proposal is a durable candidate; NOTHING is live under
 * `wiki/queries/` until `review approve` lands the page — a real apply, not a
 * zero-write check. The `--save`-without-`--review` complement proves `--review`
 * DIVERTS the save destination rather than adding a second write.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, readFile, mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import reviewApproveCommand from "../src/commands/review-approve.js";
import { maybeSaveQueryPage } from "../src/commands/query-save.js";
import { listCandidates } from "../src/compiler/candidates.js";
import { slugify } from "../src/utils/markdown.js";
import { QUERIES_DIR } from "../src/utils/constants.js";
import { buildCollidingProject, echoCallClaudeModule, mockQueryVector } from "./fixtures/typed-grounding.js";

vi.mock("../src/utils/llm.js", () => echoCallClaudeModule());
vi.mock("../src/utils/provider-guard.js", () => ({ ensureProviderAvailable: () => {} }));

const QUESTION = "scaling?";
let root = "";
let originalCwd = "";

beforeEach(async () => {
  root = await buildCollidingProject("ask-crystallize", [1, 0], [0, 1]);
  mockQueryVector([1, 1]);
  originalCwd = process.cwd();
  process.chdir(root); // review approve resolves the project from process.cwd()
});
afterEach(async () => {
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = 0;
});

const queryPage = (): string => path.join(root, QUERIES_DIR, `${slugify(QUESTION)}.md`);

describe("query --save --review proposes a durable candidate, applied to write the page", () => {
  it("stages a proposal and writes NO page until review approve lands it", async () => {
    const { generateAnswer } = await import("../src/commands/query.js");
    await generateAnswer(root, QUESTION, { save: true, review: true });
    // A durable proposal exists; nothing is live under wiki/queries/ yet.
    const proposed = await listCandidates(root);
    expect(proposed.length, "the proposal was not durable").toBe(1);
    expect(existsSync(queryPage()), "the review path wrote a page before approval").toBe(false);
    // Applying the proposal writes the query page with query frontmatter.
    await reviewApproveCommand(proposed[0]!.id);
    expect(existsSync(queryPage()), "approve did not write the query page").toBe(true);
    expect(await readFile(queryPage(), "utf8")).toContain("type: query");
    expect((await listCandidates(root)).length, "candidate not cleared after approval").toBe(0);
  });

  it("REFUSES a stale query re-save — a page edited since the proposal is not clobbered", async () => {
    const bare = await mkdtemp(path.join(os.tmpdir(), "ask-stale-"));
    await mkdir(path.join(bare, "wiki"), { recursive: true });
    await writeFile(path.join(bare, "wiki", "index.md"), "# Index\n");
    const q = "how does batching work";
    const page = path.join(bare, QUERIES_DIR, `${slugify(q)}.md`);
    const cwd = process.cwd();
    process.chdir(bare); // review approve resolves the project from cwd
    try {
      await maybeSaveQueryPage(bare, q, "Original answer.", true, false); // an existing page
      await maybeSaveQueryPage(bare, q, "Refreshed answer.", true, true); // propose a re-save (captures the target hash)
      const [candidate] = await listCandidates(bare);
      const edited = "---\ntitle: hand\n---\nRewritten by hand since the proposal.\n";
      await writeFile(page, edited); // the page changes after the proposal
      await reviewApproveCommand(candidate!.id);
      expect(process.exitCode, "a stale query re-save was approved").toBe(1);
      expect((await listCandidates(bare)).length, "candidate cleared despite refusal").toBe(1);
      expect(await readFile(page, "utf8"), "the stale proposal clobbered the edit").toBe(edited);
    } finally {
      process.chdir(cwd);
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("REFUSES when the page was CREATED after an absent-target proposal — no clobber", async () => {
    const bare = await mkdtemp(path.join(os.tmpdir(), "ask-created-"));
    await mkdir(path.join(bare, "wiki"), { recursive: true });
    await writeFile(path.join(bare, "wiki", "index.md"), "# Index\n");
    const q = "how does sharding work";
    const page = path.join(bare, QUERIES_DIR, `${slugify(q)}.md`);
    const cwd = process.cwd();
    process.chdir(bare);
    try {
      // Propose while NO page exists → the candidate expects the target absent.
      await maybeSaveQueryPage(bare, q, "Answer.", true, true);
      const [candidate] = await listCandidates(bare);
      // Another actor CREATES the page between proposal and approval.
      const created = "---\ntitle: other\n---\nCreated by another actor.\n";
      await mkdir(path.dirname(page), { recursive: true });
      await writeFile(page, created);
      await reviewApproveCommand(candidate!.id);
      expect(process.exitCode, "a create-after-proposal was approved").toBe(1);
      expect((await listCandidates(bare)).length, "candidate cleared despite refusal").toBe(1);
      expect(await readFile(page, "utf8"), "the proposal clobbered a newly created page").toBe(created);
    } finally {
      process.chdir(cwd);
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("REFUSES a candidate carrying BOTH a digest and expect-absent — a contradictory precondition", async () => {
    const bare = await mkdtemp(path.join(os.tmpdir(), "ask-contradict-"));
    await mkdir(path.join(bare, "wiki"), { recursive: true });
    await writeFile(path.join(bare, "wiki", "index.md"), "# Index\n");
    const q = "how does pipelining work";
    const page = path.join(bare, QUERIES_DIR, `${slugify(q)}.md`);
    const cwd = process.cwd();
    process.chdir(bare);
    try {
      await maybeSaveQueryPage(bare, q, "Original.", true, false); // an existing page
      await maybeSaveQueryPage(bare, q, "Refreshed.", true, true); // propose → candidate carries expectedTargetHash
      const dir = path.join(bare, ".llmwiki", "candidates");
      const file = path.join(dir, (await readdir(dir)).find((f) => f.endsWith(".json"))!);
      const stored = JSON.parse(await readFile(file, "utf8"));
      stored.expectTargetAbsent = true; // TAMPER: add the contradictory field to a digest candidate
      await writeFile(file, JSON.stringify(stored));
      await rm(page); // delete the target so a naive expect-absent branch would "succeed" and recreate it
      const [candidate] = await listCandidates(bare);
      await reviewApproveCommand(candidate!.id);
      expect(process.exitCode, "a contradictory-precondition candidate was approved").toBe(1);
      expect(existsSync(page), "the contradictory candidate recreated the deleted page").toBe(false);
    } finally {
      process.chdir(cwd);
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("REFUSES to propose when the target cannot be read (a non-ENOENT error)", async () => {
    const bare = await mkdtemp(path.join(os.tmpdir(), "ask-unreadable-"));
    await mkdir(path.join(bare, "wiki"), { recursive: true });
    await writeFile(path.join(bare, "wiki", "index.md"), "# Index\n");
    const q = "how does caching work";
    // A DIRECTORY at the target path makes the read fail with EISDIR, not ENOENT —
    // an unreadable target must refuse the proposal, never fail open to no precondition.
    await mkdir(path.join(bare, QUERIES_DIR, `${slugify(q)}.md`), { recursive: true });
    try {
      await expect(maybeSaveQueryPage(bare, q, "Answer.", true, true)).rejects.toThrow();
      expect((await listCandidates(bare)).length, "an unreadable target still staged a candidate").toBe(0);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("DIVERTS the destination: on a default project a plain save writes the page, --review proposes instead", async () => {
    // A bare default project (no profile), so the direct write is not gated —
    // isolating the ONLY difference the flag makes: the save destination.
    const bare = await mkdtemp(path.join(os.tmpdir(), "ask-default-"));
    await mkdir(path.join(bare, "wiki"), { recursive: true });
    await writeFile(path.join(bare, "wiki", "index.md"), "# Index\n");
    const pageFor = (q: string): string => path.join(bare, QUERIES_DIR, `${slugify(q)}.md`);
    try {
      // Plain --save writes the page directly; no candidate is staged.
      await maybeSaveQueryPage(bare, "how does routing work", "Routing sends tokens to experts.", true, false);
      expect(existsSync(pageFor("how does routing work")), "plain save did not write the page").toBe(true);
      // --review DIVERTS the same save into a proposal: a candidate, no page.
      await maybeSaveQueryPage(bare, "what is sparsity", "Sparsity skips most weights.", true, true);
      expect(existsSync(pageFor("what is sparsity")), "--review wrote the page directly").toBe(false);
      expect((await listCandidates(bare)).some((c) => c.slug === slugify("what is sparsity")),
        "--review staged no candidate").toBe(true);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
