/**
 * Tests for the W5 programmatic incremental compile delta (`compileDelta`).
 *
 * Verifies the hash-gated delta contract a downstream consumer relies on:
 *
 *  - A first delta compile of a single source returns that source's page.
 *  - A second delta compile with the now-up-to-date state returns an EMPTY
 *    delta (nothing changed ⇒ nothing to ship).
 *  - Adding a new source yields ONLY that new source's page in the delta.
 *
 * Strategy mirrors compile-provenance.test.ts: stub AnthropicProvider so the
 * extraction tool and page-generation calls are deterministic and no real
 * API is hit. The extraction title is derived from the source filename so
 * each source maps to a distinct, predictable slug.
 */

import { describe, it, expect, vi } from "vitest";
import { writeFile } from "fs/promises";
import path from "path";
import { compileDelta } from "../src/compiler/delta.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { useCompileProject } from "./fixtures/compile-project.js";

const FIRST_SOURCE = "alpha.md";
const FIRST_TITLE = "Alpha Topic";
const FIRST_SLUG = "alpha-topic";
const SECOND_SOURCE = "beta.md";
const SECOND_TITLE = "Beta Topic";
const SECOND_SLUG = "beta-topic";

/** Extraction JSON for one concept titled `title`. */
function extractionFor(title: string): string {
  return JSON.stringify({
    concepts: [{ concept: title, summary: `Summary of ${title}.`, is_new: true }],
  });
}

const STUB_BODY = "Body content for the topic. ^[alpha.md]";

/**
 * Stub the provider so toolCall returns extraction keyed on the source
 * currently being processed. The compiler reads one source at a time, so we
 * route by inspecting the system prompt for the source's title marker.
 */
function stubProvider(): void {
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(
    async (system: string) => {
      if (system.includes(SECOND_TITLE) || system.includes("beta")) {
        return extractionFor(SECOND_TITLE);
      }
      return extractionFor(FIRST_TITLE);
    },
  );
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(STUB_BODY);
}

describe("compileDelta — incremental change-gated delta", () => {
  const ctx = useCompileProject({
    dirSuffix: "delta",
    sourceFile: FIRST_SOURCE,
    sourceContent: `# ${FIRST_TITLE}\n\nAbout alpha.`,
  });

  it("returns the compiled page on first run, then an empty delta when unchanged", async () => {
    stubProvider();

    const first = await compileDelta(ctx.dir);
    expect(first.changedSlugs).toContain(FIRST_SLUG);
    expect(first.compiled).toBe(1);

    const second = await compileDelta(ctx.dir);
    expect(second.changedPages).toEqual([]);
    expect(second.changedSlugs).toEqual([]);
    expect(second.skipped).toBe(1);
  });

  it("returns only the newly added source's page in the delta", async () => {
    stubProvider();

    await compileDelta(ctx.dir);

    await writeFile(
      path.join(ctx.dir, "sources", SECOND_SOURCE),
      `# ${SECOND_TITLE}\n\nAbout beta.`,
      "utf-8",
    );

    const delta = await compileDelta(ctx.dir);
    expect(delta.changedSlugs).toEqual([SECOND_SLUG]);
    expect(delta.changedPages).toHaveLength(1);
    expect(delta.changedPages[0]?.slug).toBe(SECOND_SLUG);
  });
});
