/**
 * LLM citation judge for the llmwiki eval harness.
 *
 * For each cited prose paragraph in the wiki, extracts the (claim, source span)
 * pair and asks an LLM judge whether the source actually supports the claim.
 * Scoring: 0 = unsupported, 1 = partial, 2 = fully supported.
 *
 * Uses deterministic hash-based sampling so the same N citations are evaluated
 * on every run (reproducible). Results are cached in .llmwiki/eval/citation-cache.jsonl
 * so subsequent runs skip already-judged pairs.
 */

import { createHash } from "crypto";
import { readFile, appendFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { collectAllPages } from "../linter/rules.js";
import { parseFrontmatter, extractClaimCitations } from "../utils/markdown.js";
import { callClaude } from "../utils/llm.js";
import { SOURCES_DIR, DEFAULT_PROVIDER, PROVIDER_MODELS } from "../utils/constants.js";
import type { LLMTool } from "../utils/provider.js";
import type { CitationJudgement, CitationSupportResult } from "./types.js";
import type { SourceSpan } from "../utils/types.js";

const CACHE_DIR = path.join(".llmwiki", "eval");
const CACHE_FILE = path.join(CACHE_DIR, "citation-cache.jsonl");
const PROSE_LEAD_RE = /^\p{L}/u;

/** Internal pair combining a claim paragraph with its cited source span. */
interface CitationPair {
  claimHash: string;
  pageSlug: string;
  claimText: string;
  citedFile: string;
  spanText: string;
  lineStart: number;
  lineEnd: number;
}

const JUDGE_TOOL: LLMTool = {
  name: "judge_citation",
  description: "Rate how well the source excerpt supports the claim.",
  input_schema: {
    type: "object",
    properties: {
      score: {
        type: "integer",
        enum: [0, 1, 2],
        description:
          "0=not supported or contradicted, 1=partially supported, 2=fully supported",
      },
      reason: { type: "string", description: "One sentence explaining the rating." },
    },
    required: ["score", "reason"],
  },
};

const JUDGE_SYSTEM =
  "You are an expert fact-checker. Given a claim from a wiki article and a source excerpt, rate whether the source supports the claim. Be strict: partial credit only if the source addresses the claim but is incomplete.";

/** Compute a stable 16-char hex hash for a (claim, span) pair. */
function hashPair(claimText: string, spanText: string): string {
  return createHash("sha256").update(claimText + spanText).digest("hex").slice(0, 16);
}

/** Extract the text of specific lines from a file (1-indexed, inclusive). */
async function readSourceLines(filePath: string, start: number, end: number): Promise<string> {
  const content = await readFile(filePath, "utf-8");
  return content
    .split("\n")
    .slice(start - 1, end)
    .join("\n");
}

/** Strip `^[...]` markers from a paragraph to get the bare claim text. */
function stripCitationMarkers(paragraph: string): string {
  return paragraph.replace(/\^\[[^\]]+\]/g, "").trim();
}

/** Build a CitationPair from one span, or null if the source file is missing or has no line range. */
async function buildSpanPair(
  slug: string,
  claimText: string,
  span: SourceSpan,
  sourcesDir: string,
): Promise<CitationPair | null> {
  if (!span.lines) return null;
  const sourceFile = path.join(sourcesDir, span.file);
  if (!existsSync(sourceFile)) return null;
  const spanText = await readSourceLines(sourceFile, span.lines.start, span.lines.end);
  return {
    claimHash: hashPair(claimText, spanText),
    pageSlug: slug,
    claimText,
    citedFile: span.file,
    spanText,
    lineStart: span.lines.start,
    lineEnd: span.lines.end,
  };
}

/** Extract citation pairs from a single cited paragraph. */
async function extractParagraphPairs(
  slug: string,
  para: string,
  sourcesDir: string,
): Promise<CitationPair[]> {
  const citations = extractClaimCitations(para);
  if (citations.length === 0) return [];
  const claimText = stripCitationMarkers(para);
  const spans = citations.flatMap((c) => c.spans);
  const pairs = await Promise.all(spans.map((s) => buildSpanPair(slug, claimText, s, sourcesDir)));
  return pairs.filter((p): p is CitationPair => p !== null);
}

/** Extract citation pairs from a single page body. */
async function extractPagePairs(
  slug: string,
  body: string,
  sourcesDir: string,
): Promise<CitationPair[]> {
  const paragraphs = body.split(/\n\s*\n/).filter((p) => PROSE_LEAD_RE.test(p.trim()));
  const results = await Promise.all(paragraphs.map((p) => extractParagraphPairs(slug, p, sourcesDir)));
  return results.flat();
}

/**
 * Extract all (claim, source span) pairs from the wiki.
 * Only pairs with valid line ranges pointing to existing source files are included.
 * @param root - Absolute path to the project root.
 */
export async function extractCitationPairs(root: string): Promise<CitationPair[]> {
  const pages = await collectAllPages(root);
  const sourcesDir = path.join(root, SOURCES_DIR);
  const all: CitationPair[] = [];
  for (const { filePath, content } of pages) {
    const { body } = parseFrontmatter(content);
    const slug = path.basename(filePath, ".md");
    const pairs = await extractPagePairs(slug, body, sourcesDir);
    all.push(...pairs);
  }
  return all;
}

/**
 * Select a deterministic sample of N pairs by sorting on claimHash.
 * Ensures the same pairs are evaluated on every run for reproducibility.
 * @param pairs - All extracted citation pairs.
 * @param sampleSize - Maximum number of pairs to return.
 */
export function selectDeterministicSample(
  pairs: CitationPair[],
  sampleSize: number,
): CitationPair[] {
  return [...pairs].sort((a, b) => a.claimHash.localeCompare(b.claimHash)).slice(0, sampleSize);
}

/** Load previously cached judgements keyed by claimHash. */
async function loadCachedJudgements(root: string): Promise<Map<string, CitationJudgement>> {
  const cachePath = path.join(root, CACHE_FILE);
  if (!existsSync(cachePath)) return new Map();
  const content = await readFile(cachePath, "utf-8");
  const map = new Map<string, CitationJudgement>();
  for (const line of content.trim().split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line) as CitationJudgement;
      map.set(entry.claimHash, entry);
    } catch {
      // Skip malformed cache lines
    }
  }
  return map;
}

/** Append a single judgement to the cache file. */
async function appendCachedJudgement(root: string, judgement: CitationJudgement): Promise<void> {
  await mkdir(path.join(root, CACHE_DIR), { recursive: true });
  await appendFile(path.join(root, CACHE_FILE), JSON.stringify(judgement) + "\n");
}

/** Resolve the current model identifier for recording in judgements. */
function resolveModel(): string {
  const provider = process.env.LLMWIKI_PROVIDER ?? DEFAULT_PROVIDER;
  return process.env.LLMWIKI_MODEL ?? PROVIDER_MODELS[provider] ?? provider;
}

/** Call the LLM judge for a single (claim, span) pair. */
async function callJudge(pair: CitationPair): Promise<CitationJudgement> {
  const userMessage =
    `Claim: ${pair.claimText}\n\nSource (${pair.citedFile}, lines ${pair.lineStart}–${pair.lineEnd}):\n${pair.spanText}`;

  const raw = await callClaude({
    system: JUDGE_SYSTEM,
    messages: [{ role: "user", content: userMessage }],
    tools: [JUDGE_TOOL],
    maxTokens: 256,
  });

  const parsed = JSON.parse(raw) as { score: 0 | 1 | 2; reason: string };
  return {
    claimHash: pair.claimHash,
    pageSlug: pair.pageSlug,
    citedFile: pair.citedFile,
    lineStart: pair.lineStart,
    lineEnd: pair.lineEnd,
    claimText: pair.claimText,
    spanText: pair.spanText,
    score: parsed.score,
    reason: parsed.reason,
    model: resolveModel(),
    timestamp: new Date().toISOString(),
  };
}

/** Aggregate raw judgement scores into summary statistics. */
function aggregateJudgements(judgements: CitationJudgement[]): Pick<
  CitationSupportResult,
  "meanScore" | "fullySupported" | "partiallySupported" | "unsupported"
> {
  const fullySupported = judgements.filter((j) => j.score === 2).length;
  const partiallySupported = judgements.filter((j) => j.score === 1).length;
  const unsupported = judgements.filter((j) => j.score === 0).length;
  const meanScore =
    judgements.length === 0
      ? 0
      : judgements.reduce((sum, j) => sum + j.score, 0) / judgements.length;
  return { meanScore, fullySupported, partiallySupported, unsupported };
}

/**
 * Judge each non-cached pair in the sample, returning all collected judgements
 * and an error count. Throws if every non-cached call fails (credentials missing,
 * provider down, etc.) — an empty result would be meaningless.
 */
async function judgeNewPairs(
  sample: CitationPair[],
  cache: Map<string, CitationJudgement>,
  root: string,
): Promise<{ judgements: CitationJudgement[]; judgeErrors: number }> {
  const judgements: CitationJudgement[] = [];
  let judgeErrors = 0;
  let newPairsAttempted = 0;
  let firstError: unknown;

  for (const pair of sample) {
    const cached = cache.get(pair.claimHash);
    if (cached) {
      judgements.push(cached);
    } else {
      newPairsAttempted++;
      try {
        const judgement = await callJudge(pair);
        await appendCachedJudgement(root, judgement);
        judgements.push(judgement);
      } catch (err) {
        judgeErrors++;
        if (firstError === undefined) firstError = err;
      }
    }
  }

  if (newPairsAttempted > 0 && judgeErrors === newPairsAttempted) {
    const msg = firstError instanceof Error ? firstError.message : String(firstError);
    throw new Error(`Citation judge failed for all ${judgeErrors} sampled pair(s): ${msg}`);
  }

  return { judgements, judgeErrors };
}

/**
 * Run the citation support judge across a deterministic sample of wiki citations.
 * Returns null if no citable paragraphs exist.
 * @param root - Absolute path to the project root.
 * @param sampleSize - Number of citation pairs to judge per run.
 */
export async function evaluateCitationSupport(
  root: string,
  sampleSize = 20,
): Promise<CitationSupportResult | null> {
  const allPairs = await extractCitationPairs(root);
  if (allPairs.length === 0) return null;

  const sample = selectDeterministicSample(allPairs, sampleSize);
  const cache = await loadCachedJudgements(root);
  const { judgements, judgeErrors } = await judgeNewPairs(sample, cache, root);

  return {
    sampledCount: judgements.length,
    totalCitations: allPairs.length,
    judgeErrors,
    ...aggregateJudgements(judgements),
    judgements,
  };
}
