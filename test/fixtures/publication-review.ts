/**
 * Offline publication/approval fixtures use real candidate files and planner
 * writes, replacing only embedding refresh. Documents retain canonical bytes.
 */
import { afterEach, beforeEach, expect, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { useTempRoot } from "./temp-root.js";
import { stageCitationWorkspace } from "./query-answer-citations.js";
import { candidateFile } from "./answer-candidate.js";
import { maybeSaveQueryPage } from "../../src/commands/query-publication.js";
import { buildQueryDocument } from "../../src/commands/query-document.js";
import approve from "../../src/commands/review-approve.js";
import { readCandidate, writeCandidate } from "../../src/compiler/candidates.js";
import * as embeddings from "../../src/utils/embeddings.js";
import type { ReviewCandidate } from "../../src/utils/types.js";

/** Install real retained and pending targets and isolate mutable process state. */
export function usePublicationRoot() {
  const root = useTempRoot();
  beforeEach(async () => {
    process.exitCode = 0;
    await stageCitationWorkspace(root.dir);
    vi.spyOn(embeddings, "updateEmbeddingsLockedCore").mockResolvedValue({ embedded: [], eligible: [], pruned: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => { process.exitCode = 0; });
  return root;
}

/** Stage through the real query publication boundary and read the admitted record. */
export async function propose(root: string, answer = "[[Alpha]]", question = "Answer"): Promise<ReviewCandidate> {
  const document = buildQueryDocument(question, answer, "2026-09-19T00:00:00Z").document;
  const result = await maybeSaveQueryPage({ root, question, answer, save: true, review: true, document });
  expect(result.saved).toBeUndefined();
  expect(result.candidateId).toBeTypeOf("string");
  return (await readCandidate(root, result.candidateId!))!;
}

/** Stage an ordinary untyped candidate with a real full document. */
export function generic(root: string, slug: string, body: string, queries = false) {
  return writeCandidate(root, { title: slug, slug, summary: "Summary", sources: [],
    body: buildQueryDocument(slug, body, "2026-09-19T00:00:00Z").document,
    ...(queries ? { targetDirectory: "queries" as const } : {}) });
}

/** Preserve an exact copy of the candidate for no-mutation refusal checks. */
export function candidateBytes(root: string, id: string): Promise<string> {
  return readFile(candidateFile(root, id), "utf8");
}

/** Assert refusal preserves the earlier candidate snapshot and writes no page. */
export async function expectApprovalRefused(root: string, candidate: ReviewCandidate, before: string): Promise<void> {
  await approve(candidate.id);
  expect(process.exitCode).toBe(1);
  expect(await candidateBytes(root, candidate.id)).toBe(before);
  await expect(readFile(candidatePagePath(root, candidate))).rejects.toMatchObject({ code: "ENOENT" });
}

/** Approve successfully and read actual published bytes for scenario assertions. */
export async function approvePage(root: string, candidate: ReviewCandidate): Promise<string> {
  await approve(candidate.id);
  expect(process.exitCode).toBe(0);
  return readFile(candidatePagePath(root, candidate), "utf8");
}

/** Approve successfully, then assert the exact bytes landed and the candidate was cleared. */
export async function expectApprovedAndCleared(root: string, candidate: ReviewCandidate): Promise<void> {
  expect(await approvePage(root, candidate)).toBe(candidate.body);
  await expect(candidateBytes(root, candidate.id)).rejects.toMatchObject({ code: "ENOENT" });
}

/** Resolve the ordinary concept/query destination used by these fixtures. */
function candidatePagePath(root: string, candidate: ReviewCandidate): string {
  return path.join(root, "wiki", candidate.targetDirectory ?? "concepts", `${candidate.slug}.md`);
}

/** Seed an ordinary retained concept with optional aliases. */
export function retained(root: string, slug: string, aliases: string[] = []): Promise<void> {
  return writeFile(path.join(root, "wiki/concepts", `${slug}.md`),
    `---\ntitle: ${slug}\naliases: ${JSON.stringify(aliases)}\n---\nBody.\n`);
}
