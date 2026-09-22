/**
 * @file test/ask-citations-resolve.test.ts
 * @description §4.5 ask: every GROUNDING source resolves to a retained page,
 * and the context's provenance is VISIBLE — which pages and which excerpts fed
 * the model is stated, not implied. Deliberately NOT claimed: citations in the
 * ANSWER text itself — `pageIds` is selection state, populated independently
 * of the answer, and nothing validates answer citations; the status index
 * records that clause as missing.
 *
 * THE ECHO PROVIDER IS THE INSTRUMENT: `callClaude` echoes the grounding
 * prompt back as the answer, so the test reads exactly what the model was
 * shown. A real model would paraphrase its context; the echo preserves it,
 * letting the provenance claim be asserted on bytes rather than trusted.
 * Reviewed crystallization is deliberately NOT claimed here: `--save` writes
 * the derived page directly, and the status index records that gap.
 */

import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { buildCollidingProject, echoCallClaudeModule, mockQueryVector } from "./fixtures/typed-grounding.js";

vi.mock("../src/utils/llm.js", () => echoCallClaudeModule());
vi.mock("../src/utils/provider-guard.js", () => ({ ensureProviderAvailable: () => {} }));

describe("§4.5 ask grounds its answer in resolvable, visible sources", () => {
  it("every GROUNDING pageId resolves to a retained wiki page", async () => {
    const root = await buildCollidingProject("ask-cite", [1, 0], [0, 1]);
    mockQueryVector([1, 1]);
    const { generateAnswer } = await import("../src/commands/query.js");
    const result = await generateAnswer(root, "scaling?");
    // Non-vacuous: an empty grounding list would make resolution trivially true.
    expect(result.pageIds.length).toBeGreaterThan(0);
    for (const pageId of result.pageIds) {
      expect(existsSync(path.join(root, "wiki", `${pageId}.md`)), `grounding ref ${pageId} does not resolve`).toBe(true);
    }
  });

  it("the grounding context NAMES its excerpt sources, and they resolve too", async () => {
    const root = await buildCollidingProject("ask-prov", [1, 0], [0, 1]);
    mockQueryVector([1, 1]);
    const { generateAnswer } = await import("../src/commands/query.js");
    const result = await generateAnswer(root, "scaling?");
    // The echoed prompt IS the context the model saw: the provenance section
    // must be present and must label each excerpt with the page it came from.
    expect(result.answer).toContain("Most relevant excerpts");
    const labelled = [...result.answer.matchAll(/^--- ([\w/-]+) \(chunk \d+\) ---$/gm)].map((hit) => hit[1]!);
    expect(labelled.length).toBeGreaterThan(0);
    for (const pageId of labelled) {
      expect(existsSync(path.join(root, "wiki", `${pageId}.md`)), `excerpt source ${pageId} does not resolve`).toBe(true);
    }
  });
});
