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
import { trackToolCallConcurrency } from "./fixtures/concurrency-probe.js";
import { resolveCompileConcurrency, parseConcurrencyFlag } from "../src/compiler/concurrency.js";
import {
  COMPILE_CONCURRENCY,
  COMPILE_CONCURRENCY_MAX,
  ENV_COMPILE_CONCURRENCY,
} from "../src/utils/constants.js";

/** Run fn while capturing one console channel, and return the joined text. */
function capture(channel: "log" | "warn", fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, channel).mockImplementation((m?: unknown) => {
    lines.push(String(m));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

/** Capture stdout, where `output.status` writes. */
const captureStatus = (fn: () => void): string => capture("log", fn);

/** Capture stderr, where `output.note` writes. */
const captureNote = (fn: () => void): string => capture("warn", fn);
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

  it("uses a provider-neutral label for an out-of-range override, not the --concurrency flag name", () => {
    const out = captureStatus(() =>
      expect(resolveCompileConcurrency(COMPILE_CONCURRENCY_MAX + 1)).toBe(COMPILE_CONCURRENCY_MAX),
    );
    expect(out).toContain("compile concurrency");
    expect(out).not.toContain("--concurrency");
  });
});

describe("parseConcurrencyFlag", () => {
  it("returns undefined when the flag is absent", () => {
    expect(parseConcurrencyFlag(undefined)).toBeUndefined();
  });

  it("parses a valid positive integer", () => {
    expect(parseConcurrencyFlag("8")).toBe(8);
  });

  it("passes an out-of-range value through (the resolver clamps it)", () => {
    expect(parseConcurrencyFlag("999")).toBe(999);
  });

  it("rejects a non-integer flag on stderr, echoing the raw input, and leaves stdout clean", () => {
    let stdout = "";
    const stderr = captureNote(() => {
      stdout = captureStatus(() => expect(parseConcurrencyFlag("eight")).toBeUndefined());
    });

    expect(stderr).toContain('"eight"');
    // The CLI parses this flag while assembling a command's arguments, before
    // the command body can enable quiet mode, so a stdout write here is
    // unsuppressible and corrupts a --json envelope. See
    // test/quickstart-json-stdout.test.ts for that contract end to end.
    expect(stdout).toBe("");
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

/** Probe extraction concurrency and stub page generation. Returns the peak getter. */
function trackExtractionPeak(): () => number {
  const peak = trackToolCallConcurrency((n) => JSON.stringify({ concepts: [conceptRecord(`Concept ${n}`)] }));
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("A generated page body.\n");
  return peak;
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

  it("stops issuing extractions once a source fails, instead of draining the queue", async () => {
    root = await makeMultiSourceRoot("abort", {
      "a.md": "# A\n\na", "b.md": "# B\n\nb", "c.md": "# C\n\nc", "d.md": "# D\n\nd",
    });
    let calls = 0;
    vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(async () => {
      calls++;
      if (calls === 2) throw new Error("401 unauthorized"); // non-retriable: no backoff
      return JSON.stringify({ concepts: [conceptRecord(`C${calls}`)] });
    });
    vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("body\n");

    await expect(compileAndReport(root, { concurrency: 1 })).rejects.toThrow();
    // Drain any still-queued pool tasks while the mock is active, so the count
    // is deterministic. Without short-circuiting, the pLimit pool runs all 4
    // sources even though the compile is already doomed; the guard skips the rest.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBeLessThan(4);
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
