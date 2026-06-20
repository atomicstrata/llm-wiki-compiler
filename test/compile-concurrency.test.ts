/**
 * Tests for configurable compile concurrency.
 *
 * Two layers:
 *   - resolveCompileConcurrency unit tests pin the flag > env > default
 *     precedence plus the clamp/validation behaviour.
 *   - compile-path tests prove phase-1 extraction now runs in parallel under
 *     the shared cap, and that Promise.all keeps the result order stable so
 *     mergeExtractions' first-seen-wins reconciliation is unchanged.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { rm, writeFile, readFile, readdir } from "fs/promises";
import path from "path";
import { makeCompileProjectRoot } from "./fixtures/compile-project.js";
import { resolveCompileConcurrency } from "../src/compiler/concurrency.js";
import {
  COMPILE_CONCURRENCY,
  COMPILE_CONCURRENCY_MAX,
  ENV_COMPILE_CONCURRENCY,
} from "../src/utils/constants.js";
import { compileAndReport } from "../src/compiler/index.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { parseFrontmatter } from "../src/utils/markdown.js";

// ---------------------------------------------------------------------------
// resolveCompileConcurrency
// ---------------------------------------------------------------------------

describe("resolveCompileConcurrency", () => {
  afterEach(() => {
    delete process.env[ENV_COMPILE_CONCURRENCY];
  });

  it("returns the default when nothing is set", () => {
    expect(resolveCompileConcurrency()).toBe(COMPILE_CONCURRENCY);
  });

  it("honours a positive env override", () => {
    process.env[ENV_COMPILE_CONCURRENCY] = "12";
    expect(resolveCompileConcurrency()).toBe(12);
  });

  it("falls back to the default on non-integer, zero, or negative env values", () => {
    for (const bad of ["nope", "0", "-3", "2.5"]) {
      process.env[ENV_COMPILE_CONCURRENCY] = bad;
      expect(resolveCompileConcurrency()).toBe(COMPILE_CONCURRENCY);
    }
  });

  it("clamps an over-cap env value to the max", () => {
    process.env[ENV_COMPILE_CONCURRENCY] = String(COMPILE_CONCURRENCY_MAX + 100);
    expect(resolveCompileConcurrency()).toBe(COMPILE_CONCURRENCY_MAX);
  });

  it("lets the explicit flag override win over the env var", () => {
    process.env[ENV_COMPILE_CONCURRENCY] = "8";
    expect(resolveCompileConcurrency(3)).toBe(3);
  });

  it("falls back to the default when the flag override is invalid", () => {
    expect(resolveCompileConcurrency(0)).toBe(COMPILE_CONCURRENCY);
    expect(resolveCompileConcurrency(Number.NaN)).toBe(COMPILE_CONCURRENCY);
  });
});

// ---------------------------------------------------------------------------
// compile-path: parallel extraction
// ---------------------------------------------------------------------------

/** Minimal extraction concept record, marked new so a page is generated. */
function conceptRecord(name: string, summary = "s") {
  return {
    concept: name,
    summary,
    is_new: true,
    confidence: 0.9,
    provenance_state: "extracted",
    contradicted_by: [],
  };
}

/**
 * Build a project root seeded with several source files. Reuses the shared
 * compile-project fixture for the first source (and the dir scaffolding), then
 * writes the rest into sources/.
 */
async function makeMultiSourceRoot(
  suffix: string,
  sources: Record<string, string>,
): Promise<string> {
  const [[firstName, firstContent], ...rest] = Object.entries(sources);
  const root = await makeCompileProjectRoot({
    dirSuffix: `conc-${suffix}`,
    sourceFile: firstName,
    sourceContent: firstContent,
  });
  for (const [name, content] of rest) {
    await writeFile(path.join(root, "sources", name), content, "utf-8");
  }
  return root;
}

/**
 * Stub the provider so each extraction sleeps briefly while tracking how many
 * extractions are in flight at once. The returned getter reports the peak.
 */
function trackExtractionPeak(): () => number {
  let inFlight = 0;
  let peak = 0;
  let n = 0;
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 25));
    inFlight--;
    return JSON.stringify({ concepts: [conceptRecord(`Concept ${n++}`)] });
  });
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("A generated page body.\n");
  return () => peak;
}

describe("compile extraction concurrency", () => {
  let root = "";

  beforeEach(() => {
    process.env.LLMWIKI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.LLMWIKI_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("extracts sources in parallel, bounded by the concurrency cap", async () => {
    root = await makeMultiSourceRoot("cap", {
      "a.md": "# A\n\nalpha", "b.md": "# B\n\nbeta",
      "c.md": "# C\n\ngamma", "d.md": "# D\n\ndelta",
    });
    const peak = trackExtractionPeak();

    await compileAndReport(root, { concurrency: 2 });

    // Serial extraction would peak at 1; the cap of 2 must hold across 4 sources.
    expect(peak()).toBe(2);
  });

  it("runs every source at once when the cap exceeds the source count", async () => {
    root = await makeMultiSourceRoot("wide", {
      "a.md": "# A\n\nalpha", "b.md": "# B\n\nbeta", "c.md": "# C\n\ngamma",
    });
    const peak = trackExtractionPeak();

    await compileAndReport(root, { concurrency: 10 });

    expect(peak()).toBe(3);
  });

  it("preserves source order so first-seen concept metadata wins after the merge", async () => {
    root = await makeMultiSourceRoot("order", {
      "a.md": "# A\n\nALPHA-MARKER", "b.md": "# B\n\nBETA-MARKER",
    });
    vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(async (system: string) => {
      const summary = system.includes("ALPHA-MARKER") ? "from-alpha" : "from-beta";
      // Delay the alpha source so it COMPLETES last; ordered results must still
      // place it first, proving Promise.all preserves array (not completion) order.
      if (summary === "from-alpha") await new Promise((resolve) => setTimeout(resolve, 30));
      return JSON.stringify({ concepts: [conceptRecord("Shared", summary)] });
    });
    vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("Body.\n");

    await compileAndReport(root, { concurrency: 4 });

    // The compiler processes sources in readdir order; whichever it enumerates
    // first must own the merged summary regardless of completion timing.
    const firstFile = (await readdir(path.join(root, "sources"))).filter((f) => f.endsWith(".md"))[0];
    const expected = firstFile === "a.md" ? "from-alpha" : "from-beta";
    const page = await readFile(path.join(root, "wiki", "concepts", "shared.md"), "utf-8");
    expect(parseFrontmatter(page).meta.summary).toBe(expected);
  });
});
