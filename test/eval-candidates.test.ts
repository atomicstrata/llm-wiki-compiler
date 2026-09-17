/**
 * Pending evaluation regressions using the real store/parser/cache and a stubbed
 * judge only. No network or credentials: exercise revision, evidence and sampling
 * boundaries while proving the pending/live filesystem remains untouched.
 */
import { beforeEach, afterEach, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluateCandidates, formatCandidateReport } from "../src/eval/candidates.js";
import { evaluationHash } from "../src/eval/candidate-evidence.js";
import { evaluateCitationSupport } from "../src/eval/citation-support.js";
import { writeCandidate } from "../src/compiler/candidates.js";
import { callClaude } from "../src/utils/llm.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";

vi.mock("../src/utils/llm.js", () => ({ callClaude: vi.fn() }));

describe("pending candidate evaluation", () => {
  const env = useLintTempRoot("eval-pending");
  const body = "The source supports this claim. ^[ref.md:1-2]";
  const source = "Evidence first line.\nEvidence second line.";

  beforeEach(() => {
    vi.stubEnv("LLMWIKI_PROVIDER", "openai");
    vi.stubEnv("LLMWIKI_MODEL", "test-judge");
    vi.stubEnv("OPENAI_API_KEY", "test-only-not-a-real-key");
    vi.mocked(callClaude).mockReset().mockResolvedValue(JSON.stringify({ score: 2, reason: "Supported." }));
  });
  afterEach(() => vi.unstubAllEnvs());

  /** A real persisted candidate, with an optional original-source fingerprint. */
  async function stage(text = body, file = "ref.md", original: string | undefined = source) {
    return writeCandidate(env.dir, { title: "Pending", slug: "same", summary: "Draft", body: text,
      sources: [file], ...(original === undefined ? {} : { sourceStates: {
        [file]: { hash: evaluationHash(original), concepts: ["same"], compiledAt: "2026-09-17" },
      } }) });
  }

  it("keeps live verdicts and pending identity separate, preserving all content/state", async () => {
    await env.writeSource("ref.md", source);
    await env.writeConcept("same", body);
    const candidate = await stage();
    const pendingPath = path.join(env.dir, ".llmwiki/candidates", `${candidate.id}.json`);
    const original = await readFile(pendingPath, "utf8");
    await writeFile(path.join(env.dir, ".llmwiki/state.json"), "original-state");
    await evaluateCitationSupport(env.dir);
    const report = await evaluateCandidates(env.dir, "full");
    expect(callClaude).toHaveBeenCalledTimes(2);
    expect(report.candidates[0]).toMatchObject({ id: candidate.id, target: "concepts/same",
      revision: evaluationHash(original), contentHash: evaluationHash(body) });
    expect(report.assessments[0].judgement?.pageSlug).toContain(`candidate:${candidate.id}@`);
    expect(await readFile(pendingPath, "utf8")).toBe(original);
    expect(await readFile(path.join(env.dir, "wiki/concepts/same.md"), "utf8")).toBe(body);
    expect(await readFile(path.join(env.dir, ".llmwiki/state.json"), "utf8")).toBe("original-state");
    await expect(readFile(path.join(env.dir, ".llmwiki/eval/history.jsonl"))).rejects.toThrow();
  });

  it("reuses an unchanged verdict but invalidates a stable id when its revision changes", async () => {
    await env.writeSource("ref.md", source);
    const first = await stage();
    const report = await evaluateCandidates(env.dir, "full");
    await evaluateCandidates(env.dir, "full");
    expect(callClaude).toHaveBeenCalledTimes(1);
    const second = await stage(`${body}\n\nA new uncited claim.`);
    const revised = await evaluateCandidates(env.dir, "full");
    expect(first.id).toBe(second.id);
    expect(revised.candidates[0].revision).not.toBe(report.candidates[0].revision);
    expect(callClaude).toHaveBeenCalledTimes(2);
  });

  it.each(["ref.md", "nested/ref.md"])("detects changed original evidence for %s", async file => {
    await mkdir(path.dirname(path.join(env.dir, "sources", file)), { recursive: true });
    await env.writeSource(file, "Different current evidence.");
    await stage(`A cited claim. ^[${file}:1-1]`, file);
    const report = await evaluateCandidates(env.dir, "full");
    expect(report.assessments[0]).toMatchObject({ status: "unjudgeable", evidence: { status: "changed" } });
    expect(report.meanScore).toBeNull();
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("binds unrecorded evidence to actual bytes and invalidates changed spans", async () => {
    await env.writeSource("ref.md", source);
    // Legacy/imported records may never have recorded generation hashes.
    await writeCandidate(env.dir, { title: "Legacy", slug: "legacy", summary: "", sources: ["ref.md"], body });
    const first = await evaluateCandidates(env.dir, "full");
    expect(first.assessments[0].evidence).toMatchObject({ status: "unrecorded", sourceHash: evaluationHash(source), spanText: source });
    await env.writeSource("ref.md", "Different first line.\nDifferent second line.");
    const second = await evaluateCandidates(env.dir, "full");
    expect(second.assessments[0].id).not.toBe(first.assessments[0].id);
    expect(callClaude).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["An uncited claim.", "no usable citation"],
    ["Missing source. ^[ghost.md:1-2]", "missing"],
    ["Vague source. ^[ref.md]", "no usable line range"],
    ["Out of range. ^[ref.md:1-999]", "outside"],
    ["Malformed range. ^[ref.md:abc]", "missing"],
  ])("does not turn unjudgeable prose into a positive score: %s", async (text, reason) => {
    await env.writeSource("ref.md", source);
    await stage(text);
    const report = await evaluateCandidates(env.dir, "full");
    expect(report.coverage.unjudgeable).toBe(1);
    expect(report.meanScore).toBeNull();
    expect(report.assessments[0].reason).toContain(reason);
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("fast mode describes eligibility without calling the judge", async () => {
    await env.writeSource("ref.md", source);
    await stage();
    const report = await evaluateCandidates(env.dir, "fast");
    expect(report.coverage).toMatchObject({ eligiblePairs: 1, judgedPairs: 0, selectedPairs: 0 });
    expect(report.assessments[0].status).toBe("eligible");
    expect(report.meanScore).toBeNull();
    expect(callClaude).not.toHaveBeenCalled();
    expect(formatCandidateReport(report)).toContain("not measured");
  });

  it("samples deterministically and exposes unsampled observations", async () => {
    await env.writeSource("ref.md", source);
    await stage([body, "Another claim. ^[ref.md:1-1]", "Third claim. ^[ref.md:2-2]"].join("\n\n"));
    const first = await evaluateCandidates(env.dir, "full", 1);
    const second = await evaluateCandidates(env.dir, "full", 1);
    expect(first.coverage).toMatchObject({ eligiblePairs: 3, selectedPairs: 1, judgedPairs: 1 });
    expect(first.assessments.filter(item => item.status === "not-sampled")).toHaveLength(2);
    expect(first.assessments.map(item => [item.id, item.status])).toEqual(second.assessments.map(item => [item.id, item.status]));
    expect(callClaude).toHaveBeenCalledTimes(1);
  });

  it.each(["LLMWIKI_MODEL", "LLMWIKI_PROVIDER", "OPENAI_BASE_URL", "LLMWIKI_OPENAI_EXTRA_BODY",
    "LLMWIKI_OPENAI_REASONING_EFFORT"])("invalidates candidate cache on %s changes", async name => {
    await env.writeSource("ref.md", source);
    await stage();
    await evaluateCandidates(env.dir, "full");
    vi.stubEnv(name, name === "LLMWIKI_PROVIDER" ? "ollama" : "changed");
    await evaluateCandidates(env.dir, "full");
    expect(callClaude).toHaveBeenCalledTimes(2);
  });

  it.each(["not JSON", '{"score":9,"reason":"bad"}', '{"score":2}', 'null'])("rejects invalid judge responses: %s", async raw => {
    await env.writeSource("ref.md", source);
    await stage();
    vi.mocked(callClaude).mockResolvedValue(raw);
    const report = await evaluateCandidates(env.dir, "full");
    expect(report.coverage.judgeErrors).toBe(1);
    expect(report.meanScore).toBeNull();
    expect(report.assessments[0]).not.toHaveProperty("judgement");
  });

  it("includes typed and malformed records as skips without judging them", async () => {
    const candidate = await writeCandidate(env.dir, { title: "Typed", slug: "typed", summary: "",
      body, sources: [], targetEntityType: "papers" });
    await writeFile(path.join(env.dir, ".llmwiki/candidates/broken.json"), "not-json");
    const report = await evaluateCandidates(env.dir, "full");
    expect(report.skippedCandidates.map(item => item.id).sort()).toEqual(["broken", candidate.id].sort());
    expect(report.meanScore).toBeNull();
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("returns an explicit empty report for an empty queue", async () => {
    const report = await evaluateCandidates(env.dir, "full");
    expect(report.candidates).toEqual([]);
    expect(report.meanScore).toBeNull();
    expect(report.coverage.judgedPairs).toBe(0);
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("reports missing chat credentials once without trying any sampled pairs", async () => {
    await env.writeSource("ref.md", source);
    await stage(`${body}\n\nAnother claim. ^[ref.md:1-1]`);
    vi.stubEnv("OPENAI_API_KEY", "");
    const report = await evaluateCandidates(env.dir, "full");
    expect(report.judgeUnavailable).toContain("OPENAI_API_KEY");
    expect(report.coverage).toMatchObject({ selectedPairs: 2, judgeErrors: 2, judgedPairs: 0 });
    expect(formatCandidateReport(report)).toContain("OPENAI_API_KEY");
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("does not require an embedding provider to judge citations", async () => {
    await env.writeSource("ref.md", source);
    await stage();
    vi.stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "not-a-provider");
    const report = await evaluateCandidates(env.dir, "full");
    expect(report.coverage.judgedPairs).toBe(1);
    expect(report.judgeUnavailable).toBeUndefined();
  });

  it("skips a valid record copied under a different file id", async () => {
    const candidate = await stage();
    const raw = await readFile(path.join(env.dir, ".llmwiki/candidates", `${candidate.id}.json`), "utf8");
    await writeFile(path.join(env.dir, ".llmwiki/candidates/other.json"), raw);
    const report = await evaluateCandidates(env.dir, "fast");
    expect(report.candidates).toHaveLength(1);
    expect(report.skippedCandidates).toContainEqual({ id: "other", reason: expect.stringContaining("mismatched") });
  });

  it("attributes a cached live verdict to the current page, not its cache origin", async () => {
    await env.writeSource("ref.md", source);
    await env.writeConcept("first", body);
    await evaluateCitationSupport(env.dir);
    await env.writeConcept("second", body);
    const result = await evaluateCitationSupport(env.dir);
    expect(result?.judgements.map(item => item.pageSlug).sort()).toEqual(["first", "second"]);
    expect(callClaude).toHaveBeenCalledTimes(1);
  });

  it("does not persist never-reusable agent verdicts", async () => {
    await env.writeSource("ref.md", source);
    await stage();
    vi.stubEnv("LLMWIKI_PROVIDER", "codex-agent");
    await evaluateCandidates(env.dir, "full");
    await evaluateCandidates(env.dir, "full");
    expect(callClaude).toHaveBeenCalledTimes(2);
    await expect(readFile(path.join(env.dir, ".llmwiki/eval/citation-cache.jsonl"))).rejects.toThrow();
  });
});
