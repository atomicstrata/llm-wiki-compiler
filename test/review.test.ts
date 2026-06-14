/**
 * Tests for the candidate review queue: candidate persistence, approve/reject
 * CLI actions, and the compile pipeline's --review opt-in. The compile
 * integration test stubs the LLM provider so no network calls are made.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdir, writeFile, readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import {
  archiveCandidate,
  countCandidates,
  deleteCandidate,
  listCandidates,
  readCandidate,
  writeCandidate,
} from "../src/compiler/candidates.js";
import reviewApproveCommand from "../src/commands/review-approve.js";
import reviewRejectCommand from "../src/commands/review-reject.js";
import reviewListCommand from "../src/commands/review-list.js";
import reviewShowCommand from "../src/commands/review-show.js";
import { compileAndReport } from "../src/compiler/index.js";
import {
  CANDIDATES_ARCHIVE_DIR,
  CANDIDATES_DIR,
  CONCEPTS_DIR,
  STATE_FILE,
} from "../src/utils/constants.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import type { WikiState } from "../src/utils/types.js";

const VALID_BODY = [
  "---",
  "title: Sample Concept",
  'summary: "A sample summary"',
  "sources:",
  '  - "source.md"',
  'createdAt: "2026-01-01T00:00:00.000Z"',
  'updatedAt: "2026-01-01T00:00:00.000Z"',
  "tags: []",
  "aliases: []",
  "---",
  "",
  "Body content for the sample concept page.",
  "",
].join("\n");

const root = useTempRoot(["sources"]);

function sampleDraft(slug = "sample-concept") {
  return {
    title: "Sample Concept",
    slug,
    summary: "A sample summary",
    sources: ["source.md"],
    body: VALID_BODY,
  };
}

describe("candidates module", () => {
  it("writes a candidate JSON file under .llmwiki/candidates/", async () => {
    const candidate = await writeCandidate(root.dir, sampleDraft());
    expect(candidate.id).toMatch(/^sample-concept-[0-9a-f]+$/);

    const filePath = path.join(root.dir, CANDIDATES_DIR, `${candidate.id}.json`);
    expect(existsSync(filePath)).toBe(true);
  });

  it("reads back a written candidate verbatim", async () => {
    const candidate = await writeCandidate(root.dir, sampleDraft());
    const loaded = await readCandidate(root.dir, candidate.id);
    expect(loaded).toEqual(candidate);
  });

  it("lists pending candidates sorted by generation time", async () => {
    const first = await writeCandidate(root.dir, sampleDraft("alpha"));
    // Sleep-free ordering: rewrite generatedAt explicitly so the test never races.
    const filePath = path.join(root.dir, CANDIDATES_DIR, `${first.id}.json`);
    const earlier = { ...first, generatedAt: "2025-01-01T00:00:00.000Z" };
    await writeFile(filePath, JSON.stringify(earlier, null, 2));

    const second = await writeCandidate(root.dir, sampleDraft("beta"));
    const all = await listCandidates(root.dir);
    expect(all.map((c) => c.id)).toEqual([first.id, second.id]);
  });

  it("counts candidates without parsing each file body", async () => {
    await writeCandidate(root.dir, sampleDraft("alpha"));
    await writeCandidate(root.dir, sampleDraft("beta"));
    expect(await countCandidates(root.dir)).toBe(2);
  });

  it("countCandidates and listCandidates agree even with malformed JSON files", async () => {
    await writeCandidate(root.dir, sampleDraft("good"));
    // Drop a syntactically-broken candidate file alongside the valid one.
    const candidatesDir = path.join(root.dir, CANDIDATES_DIR);
    await writeFile(
      path.join(candidatesDir, "broken-candidate.json"),
      "{ this is not valid json",
      "utf-8",
    );

    const listed = await listCandidates(root.dir);
    const counted = await countCandidates(root.dir);
    expect(counted).toBe(listed.length);
    expect(counted).toBe(1);
  });

  it("returns null when reading a missing candidate", async () => {
    expect(await readCandidate(root.dir, "no-such-id")).toBeNull();
  });

  it("deletes a candidate and reports whether it existed", async () => {
    const candidate = await writeCandidate(root.dir, sampleDraft());
    expect(await deleteCandidate(root.dir, candidate.id)).toBe(true);
    expect(existsSync(path.join(root.dir, CANDIDATES_DIR, `${candidate.id}.json`))).toBe(false);
    expect(await deleteCandidate(root.dir, candidate.id)).toBe(false);
  });

  it("archives a rejected candidate without removing the record", async () => {
    const candidate = await writeCandidate(root.dir, sampleDraft());
    expect(await archiveCandidate(root.dir, candidate.id)).toBe(true);

    const pending = path.join(root.dir, CANDIDATES_DIR, `${candidate.id}.json`);
    const archived = path.join(root.dir, CANDIDATES_ARCHIVE_DIR, `${candidate.id}.json`);
    expect(existsSync(pending)).toBe(false);
    expect(existsSync(archived)).toBe(true);
  });
});

describe("review approve command", () => {
  it("writes the candidate body into wiki/concepts and clears the candidate", async () => {
    const candidate = await writeCandidate(root.dir, sampleDraft());
    vi.spyOn(console, "log").mockImplementation(() => {});

    await reviewApproveCommand(candidate.id);

    const pagePath = path.join(root.dir, CONCEPTS_DIR, "sample-concept.md");
    expect(existsSync(pagePath)).toBe(true);
    const content = await readFile(pagePath, "utf-8");
    expect(content).toBe(VALID_BODY);

    const candidateFile = path.join(root.dir, CANDIDATES_DIR, `${candidate.id}.json`);
    expect(existsSync(candidateFile)).toBe(false);
  });

  it("rejects approval when the candidate body is invalid", async () => {
    const draft = { ...sampleDraft("broken"), body: "no frontmatter here" };
    const candidate = await writeCandidate(root.dir, draft);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await reviewApproveCommand(candidate.id);

    expect(process.exitCode).toBe(1);
    expect(existsSync(path.join(root.dir, CONCEPTS_DIR, "broken.md"))).toBe(false);
    process.exitCode = 0;
    errorSpy.mockRestore();
  });
});

describe("review reject command", () => {
  it("archives the candidate without touching wiki/concepts", async () => {
    const candidate = await writeCandidate(root.dir, sampleDraft());
    vi.spyOn(console, "log").mockImplementation(() => {});

    await reviewRejectCommand(candidate.id);

    expect(existsSync(path.join(root.dir, CONCEPTS_DIR, "sample-concept.md"))).toBe(false);
    const archivePath = path.join(root.dir, CANDIDATES_ARCHIVE_DIR, `${candidate.id}.json`);
    expect(existsSync(archivePath)).toBe(true);
  });

  it("sets exit code 1 when the candidate is missing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await reviewRejectCommand("missing-id-x");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

describe("review list and show commands", () => {
  it("list reports a quiet message when no candidates exist", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await reviewListCommand();
    const allOutput = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(allOutput).toContain("No pending candidates.");
  });

  it("show prints the candidate id, slug, and body", async () => {
    const candidate = await writeCandidate(root.dir, sampleDraft());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await reviewShowCommand(candidate.id);
    const allOutput = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(allOutput).toContain(candidate.id);
    expect(allOutput).toContain("sample-concept");
    expect(allOutput).toContain("Body content for the sample concept page.");
  });
});

describe("compile --review pipeline integration", () => {
  it("creates candidates and leaves wiki/ untouched", async () => {
    await writeFile(
      path.join(root.dir, "sources", "topic.md"),
      "# Topic\nA brief article about a single topic.",
    );

    const llm = await import("../src/utils/llm.js");
    const callSpy = vi.spyOn(llm, "callClaude").mockImplementation(async ({ tools }) => {
      if (tools && tools.length > 0) {
        return JSON.stringify({
          concepts: [
            { concept: "Topic", summary: "A topic.", is_new: true, tags: ["intro"] },
          ],
        });
      }
      return "## Topic\n\nThe page body for the topic.";
    });

    const result = await compileAndReport(root.dir, { review: true });
    expect(callSpy).toHaveBeenCalled();
    expect(result.candidates ?? []).toHaveLength(1);
    expect(result.pages).toEqual([]);

    // Pages on disk: only the candidate, never the wiki page.
    const conceptsDir = path.join(root.dir, CONCEPTS_DIR);
    expect(existsSync(path.join(conceptsDir, "topic.md"))).toBe(false);

    const candidateFiles = await readdir(path.join(root.dir, CANDIDATES_DIR));
    expect(candidateFiles.filter((f) => f.endsWith(".json"))).toHaveLength(1);
  });

  /**
   * End-to-end incremental-state regression test for Finding 1.
   *
   * Prior to the fix, `compile --review` skipped state.json writes entirely.
   * That left every approved source still flagged "new" in change detection,
   * so the next compile would regenerate the same candidate over and over.
   * Approving a candidate must persist its source-state snapshot so the
   * source is treated as "unchanged" on subsequent compiles.
   */
  it("does not regenerate a candidate for a source that was approved", async () => {
    await writeFile(
      path.join(root.dir, "sources", "topic.md"),
      "# Topic\nA brief article about a single topic.",
    );

    const llm = await import("../src/utils/llm.js");
    vi.spyOn(llm, "callClaude").mockImplementation(async ({ tools }) => {
      if (tools && tools.length > 0) {
        return JSON.stringify({
          concepts: [
            { concept: "Topic", summary: "A topic.", is_new: true, tags: [] },
          ],
        });
      }
      return VALID_BODY;
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const first = await compileAndReport(root.dir, { review: true });
    expect(first.candidates).toHaveLength(1);

    const candidateId = first.candidates![0];
    await reviewApproveCommand(candidateId);

    const second = await compileAndReport(root.dir, { review: true });
    expect(second.candidates ?? []).toHaveLength(0);
    expect(second.compiled).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(1);
  });

  /**
   * Regression test for the multi-candidate-per-source scenario.
   *
   * When a single source yields multiple candidates, each approval immediately
   * union-adds its own slug to the source's state entry. A pending sibling does
   * NOT block the write — addApprovedSlugToSourceState reads current state and
   * appends, so earlier-approved slugs are preserved when the sibling is later
   * approved. After all candidates are approved the followup compile is a no-op.
   */
  it("records each approval immediately so no slug is dropped when siblings exist", async () => {
    await writeFile(
      path.join(root.dir, "sources", "topic.md"),
      "# Topic\nA brief article covering two related concepts.",
    );
    await stubMultiConceptLLM();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const first = await compileAndReport(root.dir, { review: true });
    expect(first.candidates).toHaveLength(2);

    const [firstId, secondId] = first.candidates!;
    await reviewApproveCommand(firstId);
    // First approval immediately records its slug — no longer deferred.
    expect(await readSourceState(root.dir, "topic.md")).toBeDefined();

    await reviewApproveCommand(secondId);
    expect(await readSourceState(root.dir, "topic.md")).toBeDefined();

    const followup = await compileAndReport(root.dir, { review: true });
    expect(followup.candidates ?? []).toHaveLength(0);
    expect(followup.compiled).toBe(0);
  });

  /**
   * Regression test for Finding 2: `compile --review` must NOT mutate
   * `wiki/concepts/*.md` even when sources are deleted. Orphan-marking is
   * deferred to the next non-review compile pass.
   */
  it("does not mark wiki pages orphaned when a source is deleted in review mode", async () => {
    await seedExistingPage(root.dir, "topic", ["topic"]);
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Source absent from sources/ but present in state.json → detected as deleted.
    const result = await compileAndReport(root.dir, { review: true });
    expect(result.deleted).toBe(1);

    const pageContent = await readFile(
      path.join(root.dir, CONCEPTS_DIR, "topic.md"),
      "utf-8",
    );
    expect(pageContent).not.toContain("orphaned: true");
  });
});

/** Read a single source's persisted state entry, or undefined if absent. */
async function readSourceState(
  root: string,
  sourceFile: string,
): Promise<WikiState["sources"][string] | undefined> {
  const raw = await readFile(path.join(root, STATE_FILE), "utf-8").catch(() => "");
  if (!raw) return undefined;
  const state = JSON.parse(raw) as WikiState;
  return state.sources[sourceFile];
}

/** Stub the LLM so a single source extracts to TWO concepts (one body each). */
async function stubMultiConceptLLM(): Promise<void> {
  const llm = await import("../src/utils/llm.js");
  let bodyCallCount = 0;
  vi.spyOn(llm, "callClaude").mockImplementation(async ({ tools }) => {
    if (tools && tools.length > 0) {
      return JSON.stringify({
        concepts: [
          { concept: "Alpha", summary: "First concept.", is_new: true, tags: [] },
          { concept: "Beta", summary: "Second concept.", is_new: true, tags: [] },
        ],
      });
    }
    bodyCallCount += 1;
    const title = bodyCallCount === 1 ? "Alpha" : "Beta";
    const summary = bodyCallCount === 1 ? "First concept." : "Second concept.";
    return buildValidPageBody(title, summary);
  });
}

/** Compose a frontmatter+body page string that passes validateWikiPage. */
function buildValidPageBody(title: string, summary: string): string {
  return [
    "---",
    `title: ${title}`,
    `summary: "${summary}"`,
    "sources:",
    '  - "topic.md"',
    'createdAt: "2026-01-01T00:00:00.000Z"',
    'updatedAt: "2026-01-01T00:00:00.000Z"',
    "tags: []",
    "aliases: []",
    "---",
    "",
    `Body for ${title}.`,
    "",
  ].join("\n");
}

/** Pre-seed state.json + a wiki page for a source that will then be "deleted". */
async function seedExistingPage(
  root: string,
  slug: string,
  conceptSlugs: string[],
): Promise<void> {
  const state: WikiState = {
    version: 1,
    indexHash: "",
    sources: {
      "topic.md": {
        hash: "stale-hash",
        concepts: conceptSlugs,
        compiledAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(root, STATE_FILE), JSON.stringify(state, null, 2));
  await writeFile(
    path.join(root, CONCEPTS_DIR, `${slug}.md`),
    buildValidPageBody(slug, "seeded"),
  );
}
