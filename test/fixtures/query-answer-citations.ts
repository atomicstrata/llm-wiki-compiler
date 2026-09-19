/**
 * Real on-disk citation fixtures shared by the SDK and built CLI witnesses.
 * Candidate admission stays production-owned; no report/index helpers are mocked.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AnswerCitation, AnswerCitationReport } from "../../src/index.js";

export const CITED_ANSWER = "[[Alpha|label]] [[beta]] [[missing]] [[ALPHA]]\n\n"
  + "`[[code-only]]` [See [[link-only]]](https://example.com)\n"
  + "\\[[escaped-only]]\n\n~~~\n[[fenced-only]]\n~~~";
export const EXPECTED_REPORT = {
  version: 1,
  citations: [
    { target: "alpha", status: "resolved", pageId: "concepts/alpha" },
    { target: "beta", status: "pending", candidateIds: ["pending-beta"] },
    { target: "missing", status: "broken" },
  ] satisfies AnswerCitation[],
} satisfies AnswerCitationReport;

/** Stage a retained page, a real admitted pending proposal, and an index. */
export async function stageCitationWorkspace(root: string): Promise<void> {
  for (const dir of ["wiki/concepts", "wiki/queries", ".llmwiki/candidates"]) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await writeFile(path.join(root, "wiki/index.md"), "# Wiki\n");
  await writeFile(path.join(root, "wiki/concepts/alpha.md"),
    "---\ntitle: Alpha\nsummary: Retained grounding\nsources: []\n---\nAlpha body.\n");
  await writeFile(path.join(root, ".llmwiki/candidates/pending-beta.json"), JSON.stringify({
    id: "pending-beta", slug: "beta", title: "Beta", summary: "Pending", body: "Beta body.",
    sources: [], generatedAt: "2026-09-18T00:00:00Z", reviewMode: "forced",
    heldReasons: [{ code: "manual-review-requested" }],
  }));
}

/** Snapshot only page/candidate filenames and bytes; query activity logs may change. */
export async function citationWorkspaceBytes(root: string): Promise<Record<string, Buffer>> {
  const result: Record<string, Buffer> = {};
  for (const dir of ["wiki/concepts", "wiki/queries", ".llmwiki/candidates"]) {
    for (const name of (await readdir(path.join(root, dir))).sort()) {
      const relative = `${dir}/${name}`;
      result[relative] = await readFile(path.join(root, relative));
    }
  }
  return result;
}
