/**
 * @file test/compile-marker-ordering.test.ts
 * @description Proves the compile incremental marker advances ONLY at the single
 * draft flush after the resolution phase commits.
 *
 * The pipeline buffers every state mutation in a {@link CompileStateDraft} and
 * flushes once, inside `finalizeWiki`, AFTER `resolveLinks` returns. So a crash
 * during resolution must leave state.json WITHOUT the just-compiled source
 * markers — a follow-up compile then re-detects and completes them. A normal
 * compile flushes exactly once and produces the same state.json as before.
 *
 * `resolveAndApplyLinks` (the compute+apply resolution seam `finalizeWiki` now
 * calls) is injected as the failure seam via `vi.mock` (a module mock — the
 * pipeline imports it by named ESM binding, so a `vi.spyOn` on the module object
 * would not intercept the in-pipeline call). A mutable flag lets the first
 * compile throw at resolution and the second proceed normally.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "fs";
import { readFile, mkdtemp, writeFile, mkdir, symlink, readdir } from "fs/promises";
import os from "os";
import path from "path";
import { STATE_FILE, LLMWIKI_DIR, CONCEPTS_DIR } from "../src/utils/constants.js";
import { JournalUnsafeError } from "../src/trust/journal-recovery.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { makeCompileProjectRoot } from "./fixtures/compile-project.js";
import { readPersistedState } from "./fixtures/state-json.js";

/** Flag the mocked resolution seam to decide whether to throw. */
const resolve = { shouldThrow: false };

vi.mock("../src/compiler/resolver.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/compiler/resolver.js")>();
  return {
    ...actual,
    resolveAndApplyLinks: async (root: string, changed: string[], created: string[]) => {
      if (resolve.shouldThrow) throw new Error("injected resolution failure");
      return actual.resolveAndApplyLinks(root, changed, created);
    },
  };
});

const TITLE = "Marker Topic";
const SLUG = "marker-topic";

/** Stub extraction + page-body so the compile is deterministic and offline. */
function stubLLM(): void {
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(
    JSON.stringify({ concepts: [{ concept: TITLE, summary: "A topic.", is_new: true }] }),
  );
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(
    "Body content for the topic. ^[sample.md]",
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
}

let dir = "";

beforeEach(async () => {
  process.env.LLMWIKI_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test-key";
  resolve.shouldThrow = false;
  dir = await makeCompileProjectRoot({
    dirSuffix: "marker-order",
    sourceContent: `# ${TITLE}\n\nAbout the topic.`,
  });
  stubLLM();
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.LLMWIKI_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("compile marker ordering — draft flush after resolution", () => {
  it("a throw at resolution leaves no compiled marker; a follow-up compile completes it", async () => {
    const { compileAndReport } = await import("../src/compiler/index.js");

    resolve.shouldThrow = true;
    await expect(compileAndReport(dir)).rejects.toThrow("injected resolution failure");
    // Draft never flushed: the source is NOT recorded as compiled on disk.
    const stateExists = existsSync(path.join(dir, STATE_FILE));
    if (stateExists) {
      expect((await readPersistedState(dir)).sources["sample.md"]).toBeUndefined();
    }

    resolve.shouldThrow = false;
    const result = await compileAndReport(dir);
    // The source is re-detected (still "new") and now compiles to completion.
    expect(result.compiled).toBe(1);
    expect((await readPersistedState(dir)).sources["sample.md"].concepts).toEqual([SLUG]);
  });

  it("a normal compile flushes once and records the compiled source", async () => {
    const { compileAndReport } = await import("../src/compiler/index.js");

    const result = await compileAndReport(dir);
    expect(result.compiled).toBe(1);

    const raw = await readFile(path.join(dir, STATE_FILE), "utf-8");
    const state = JSON.parse(raw);
    expect(state.sources["sample.md"].concepts).toEqual([SLUG]);
    expect(state.version).toBe(1);
  });

  it("an unsafe (symlink-escaping) journal aborts compile, touching no pages or state", async () => {
    const { compileAndReport } = await import("../src/compiler/index.js");

    // Symlink `.llmwiki/journal` to an outside dir so strict pre-compile
    // recovery classifies it `unsafe` and the compile fails closed.
    const outside = await mkdtemp(path.join(os.tmpdir(), "marker-journal-escape-"));
    await mkdir(path.join(dir, LLMWIKI_DIR), { recursive: true });
    await symlink(outside, path.join(dir, LLMWIKI_DIR, "journal"), "dir");
    await writeFile(path.join(outside, "victim.json"), "OUTSIDE", "utf-8");

    await expect(compileAndReport(dir)).rejects.toBeInstanceOf(JournalUnsafeError);

    // No state and no concept page were written — the abort is before any read/write.
    expect(existsSync(path.join(dir, STATE_FILE))).toBe(false);
    expect((await readdir(path.join(dir, CONCEPTS_DIR))).filter((f) => f.endsWith(".md"))).toHaveLength(0);
  });
});
