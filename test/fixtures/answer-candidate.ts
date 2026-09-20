/**
 * Candidate admission fixtures with deliberately untrusted on-disk variants.
 * Keep canonical valid metadata shared across schema and lifecycle witnesses.
 */
import { writeFile } from "fs/promises";
import path from "path";
import { sha256Text } from "../../src/connectors/hash.js";
import type { CandidateDraft } from "../../src/compiler/candidates.js";

/** Build an answer proposal without invoking generation or publication. */
export function answerDraft() {
  return { title: "Answer", slug: "answer", summary: "Summary", sources: [], body: "Answer body.",
    targetDirectory: "queries", reviewMode: "forced",
    candidateKind: { name: "validated-answer", version: 1 },
    citationManifest: { version: 1, bodyDigest: sha256Text("Answer body."), citations: [] },
  } satisfies CandidateDraft;
}

/** Replace candidate bytes directly, bypassing the writer's admission checks. */
export async function replaceCandidate(root: string, id: string, value: unknown): Promise<string> {
  const raw = JSON.stringify(value, null, 2) + "\n";
  await writeFile(path.join(root, ".llmwiki/candidates", `${id}.json`), raw);
  return raw;
}

/** Return original persisted bytes by the caller-supplied file identity. */
export function candidateFile(root: string, id: string): string {
  return path.join(root, ".llmwiki/candidates", `${id}.json`);
}
