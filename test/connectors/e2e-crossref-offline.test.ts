/**
 * @file test/connectors/e2e-crossref-offline.test.ts
 * @description Offline Crossref connector proof through substrate, review show, and approval pin.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import reviewApproveCommand from "../../src/commands/review-approve.js";
import reviewShowCommand from "../../src/commands/review-show.js";
import { listCandidates } from "../../src/compiler/candidates.js";
import { readConnectorBlock } from "../../src/connectors/fence.js";
import { runConnector } from "../../src/connectors/run.js";
import { applyContentTiers } from "../../src/context/content-tiers.js";
import { parseFrontmatter } from "../../src/utils/markdown.js";
import { buildResearchProject, RESEARCH_PROFILE } from "../fixtures/research-profile.js";

const FIXTURE_PATH = path.resolve("test/fixtures/crossref-work.json");
const FINAL_URL = "https://api.crossref.org/works/10.123%2Fexample";
const CONTENT_HASH = "d".repeat(64);

/** Extract the live operator pin printed by `review show`. */
function hashFromShow(stdout: string): string {
  const match = stdout.match(/draft-content-hash:\s*([0-9a-f]{64})/);
  if (!match) throw new Error(`missing draft-content-hash in output:\n${stdout}`);
  return match[1]!;
}

/** Temporarily run a command as if invoked from `root`. */
async function inProject<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prior = process.cwd();
  process.chdir(root);
  try {
    return await fn();
  } finally {
    process.chdir(prior);
  }
}

/** Write project connector config with or without Crossref's required contact email. */
async function writeConnectorConfig(root: string, includeContact: boolean): Promise<void> {
  const dir = path.join(root, ".llmwiki");
  const crossref = includeContact
    ? { contactEmail: "ops@example.com", allowedHosts: ["api.crossref.org"] }
    : { allowedHosts: ["api.crossref.org"] };
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "config.json"), JSON.stringify({ connectors: { crossref } }), "utf8");
}

/** Build a temporary research project and clean it up after the callback. */
async function withResearchProject(prefix: string, fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await buildResearchProject(root);
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Run Crossref through the host substrate with an offline fixture fetcher. */
async function stageCrossref(root: string, body?: string, contentHash = CONTENT_HASH, now?: () => Date) {
  const fixture = body ?? await readFile(FIXTURE_PATH, "utf8");
  return runConnector(root, "crossref", { doi: "10.123/example" }, {
    fetcher: async () => ({
      kind: "ok",
      finalUrl: FINAL_URL,
      bytes: Buffer.from(fixture, "utf8"),
      contentHash,
    }),
    now,
  });
}

/** Capture `review show` output for one candidate id. */
async function showCandidate(root: string, id: string): Promise<string> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await inProject(root, () => reviewShowCommand(id));
    return log.mock.calls.flat().join("\n");
  } finally {
    log.mockRestore();
  }
}

/** Stage one Crossref candidate after installing config and env activation. */
async function stageCrossrefCandidate(root: string) {
  await writeConnectorConfig(root, true);
  process.env.LLMWIKI_CONNECTORS = "crossref";
  expect((await stageCrossref(root)).kind).toBe("staged");
  const [candidate] = await listCandidates(root);
  if (!candidate) throw new Error("missing Crossref candidate");
  return candidate;
}

/** Approve one candidate from a project root. */
function approveCandidate(root: string, id: string, pin?: string): Promise<void> {
  return inProject(root, () => reviewApproveCommand(id, pin ? { draftContentHash: pin } : {}));
}

/** Project a paper page's content tiers and return its title tier content. */
function titleTierContent(root: string, meta: Record<string, unknown>, body: string): string | undefined {
  const out = applyContentTiers(contentPack(root), contentSnapshot(root, meta, body), RESEARCH_PROFILE);
  return out.primary[0]?.contentTiers?.find((tier) => tier.tier === "title")?.content;
}

/** Minimal context pack for the approved Crossref paper. */
function contentPack(root: string) {
  return {
    version: 1,
    prompt: "Example Paper",
    primary: [{
      id: "papers/crossref-10-123-example",
      title: "Example Paper",
      pageDirectory: "papers",
      score: 1,
      reasons: ["title-match"],
      summary: "",
      chunks: [],
      citations: [],
      sourceWindows: [],
      warnings: [],
      freshnessStatus: "fresh",
      contradicted: false,
      archived: false,
    }],
    neighbors: [],
    warnings: [],
    gaps: [],
    suggestedActions: [],
    project: { root, pages: 1, pendingCandidates: 0, lint: null },
    budget: { requestedTokens: 1000, estimatedTokens: 1, truncated: false, trimmedSections: [] },
  } as const;
}

/** Minimal viewer snapshot for the approved Crossref paper. */
function contentSnapshot(root: string, frontmatter: Record<string, unknown>, body: string) {
  return {
    pages: [{
      id: "papers/crossref-10-123-example",
      pageDirectory: "papers",
      slug: "crossref-10-123-example",
      title: "Example Paper",
      filePath: path.join(root, "wiki", "papers", "crossref-10-123-example.md"),
      frontmatter,
      aliases: [],
      body,
      outgoingLinks: [],
      danglingLinks: [],
      citations: [],
      warnings: [],
      freshness: { freshnessStatus: "fresh", contradicted: false, archived: false },
    }],
    links: [],
    warnings: [],
    index: { available: false, href: "", body: "", outgoingLinks: [] },
  } as const;
}

/** Rewrite one staged connector candidate with a tampered body and stored hash. */
async function tamperCandidateBody(root: string, id: string): Promise<void> {
  const file = path.join(root, ".llmwiki", "candidates", `${id}.json`);
  const raw = JSON.parse(await readFile(file, "utf8"));
  raw.body = `${raw.body}\nTampered after review.`;
  raw.connectorProvenance.draftContentHash = "0".repeat(64);
  await writeFile(file, JSON.stringify(raw, null, 2), "utf8");
}

/** Return a Crossref fixture variant with changed reviewed content. */
async function changedCrossrefFixture(): Promise<string> {
  const raw = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  raw.message.title = ["Example Paper Revised"];
  raw.message.abstract = "<jats:p>Changed Crossref abstract.</jats:p>";
  return JSON.stringify(raw);
}

/** Return a Crossref fixture variant with no publication date (year undefined). */
async function yearlessCrossrefFixture(): Promise<string> {
  const raw = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  delete raw.message["published-print"];
  delete raw.message["published-online"];
  delete raw.message.issued;
  return JSON.stringify(raw);
}

describe("Crossref connector offline e2e", () => {
  afterEach(() => {
    delete process.env.LLMWIKI_CONNECTORS;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("stages, shows fenced content, and approves only with the live body hash", async () => {
    await withResearchProject("crossref-e2e-", async (root) => {
      const candidate = await stageCrossrefCandidate(root);
      expect(candidate?.reviewMode).toBe("connector");

      const showOutput = await showCandidate(root, candidate.id);
      expect(showOutput).toContain("UNTRUSTED");
      await approveCandidate(root, candidate.id);
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;

      await approveCandidate(root, candidate.id, hashFromShow(showOutput));
      const page = await readFile(path.join(root, "wiki", "papers", "crossref-10-123-example.md"), "utf8");
      const { meta, body } = parseFrontmatter(page);
      expect(readConnectorBlock(meta)?.externalFields).toEqual(expect.arrayContaining(["title", "doi", "authors", "year"]));
      expect(titleTierContent(root, meta, body)).toContain("UNTRUSTED");
    });
  });

  it("refuses approval when the candidate body changes after review show", async () => {
    await withResearchProject("crossref-stale-", async (root) => {
      const candidate = await stageCrossrefCandidate(root);
      const pin = hashFromShow(await showCandidate(root, candidate.id));
      await tamperCandidateBody(root, candidate.id);
      await approveCandidate(root, candidate.id, pin);
      expect(process.exitCode).toBe(1);
    });
  });

  it("stages changed Crossref content under a fresh candidate id", async () => {
    await withResearchProject("crossref-supersede-", async (root) => {
      await writeConnectorConfig(root, true);
      process.env.LLMWIKI_CONNECTORS = "crossref";
      const first = await stageCrossref(root, undefined, CONTENT_HASH, () => new Date("2026-07-08T00:00:00.000Z"));
      const second = await stageCrossref(root, await changedCrossrefFixture(), "e".repeat(64), () => new Date("2026-07-08T00:00:01.001Z"));
      const firstId = first.kind === "staged" ? first.candidateIds[0] : "";
      expect(second.kind).toBe("superseded");
      const candidates = await listCandidates(root);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.id).not.toBe(firstId);
    });
  });

  it("stages a work with no publication year by omitting the mapped field", async () => {
    await withResearchProject("crossref-yearless-", async (root) => {
      await writeConnectorConfig(root, true);
      process.env.LLMWIKI_CONNECTORS = "crossref";
      const result = await stageCrossref(root, await yearlessCrossrefFixture());
      expect(result.kind).toBe("staged");
      const [candidate] = await listCandidates(root);
      const { meta } = parseFrontmatter(candidate!.body);
      expect(meta.title).toBe("Example Paper");
      expect("year" in meta).toBe(false);
    });
  });

  it("refuses Crossref before fetch when contactEmail is missing", async () => {
    await withResearchProject("crossref-contact-", async (root) => {
      await writeConnectorConfig(root, false);
      process.env.LLMWIKI_CONNECTORS = "crossref";
      let fetched = false;
      const result = await runConnector(root, "crossref", { doi: "10.123/example" }, {
        fetcher: async () => {
          fetched = true;
          throw new Error("fetcher should not run without contactEmail");
        },
      });
      expect(result.kind).toBe("refused");
      expect(fetched).toBe(false);
    });
  });
});
