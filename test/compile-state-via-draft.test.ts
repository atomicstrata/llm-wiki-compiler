/**
 * @file test/compile-state-via-draft.test.ts
 * @description (M5) guard — during compile, ALL incremental state access flows
 * through the {@link CompileStateDraft}; the only disk-state writers the pipeline
 * touches are the draft's own `readState` (at load) and `writeState` (at the
 * single flush). The incremental on-disk helpers `updateSourceState` /
 * `removeSourceState` must NEVER be called from the pipeline body.
 *
 * Strategy: `vi.mock` the state module so `updateSourceState` /
 * `removeSourceState` THROW "called directly during compile", while `readState`
 * and `writeState` pass through to the real implementation (the draft needs
 * both). A full compile — including a deleted source, which exercises the
 * orphan-remove path that previously called `removeSourceState` — must complete
 * without tripping either throwing helper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, rm } from "fs/promises";
import path from "path";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { makeCompileProjectRoot } from "./fixtures/compile-project.js";
import { readPersistedState } from "./fixtures/state-json.js";

vi.mock("../src/utils/state.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/utils/state.js")>();
  return {
    ...actual,
    updateSourceState: vi.fn(() => {
      throw new Error("updateSourceState called directly during compile");
    }),
    removeSourceState: vi.fn(() => {
      throw new Error("removeSourceState called directly during compile");
    }),
  };
});

const KEEP_SOURCE = "keep.md";
const KEEP_TITLE = "Keep Topic";
const KEEP_SLUG = "keep-topic";
const DROP_SOURCE = "drop.md";
const DROP_TITLE = "Drop Topic";

/** Route extraction by the source title present in the system prompt. */
function stubLLM(): void {
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(async (system: string) => {
    const title = system.includes(DROP_TITLE) || system.includes("drop") ? DROP_TITLE : KEEP_TITLE;
    return JSON.stringify({ concepts: [{ concept: title, summary: "A topic.", is_new: true }] });
  });
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("Body. ^[keep.md]");
  vi.spyOn(console, "log").mockImplementation(() => {});
}

let dir = "";

beforeEach(async () => {
  process.env.LLMWIKI_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test-key";
  dir = await makeCompileProjectRoot({
    dirSuffix: "via-draft",
    sourceFile: KEEP_SOURCE,
    sourceContent: `# ${KEEP_TITLE}\n\nAbout keep.`,
  });
  await writeFile(path.join(dir, "sources", DROP_SOURCE), `# ${DROP_TITLE}\n\nAbout drop.`, "utf-8");
  stubLLM();
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.LLMWIKI_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("(M5) compile routes all incremental state through the draft", () => {
  it("compiles new sources without calling updateSourceState/removeSourceState", async () => {
    const state = await import("../src/utils/state.js");
    const { compileAndReport } = await import("../src/compiler/index.js");

    const result = await compileAndReport(dir);

    expect(result.errors).toEqual([]);
    expect(state.updateSourceState).not.toHaveBeenCalled();
    expect(state.removeSourceState).not.toHaveBeenCalled();
    expect((await readPersistedState(dir)).sources[KEEP_SOURCE].concepts).toEqual([KEEP_SLUG]);
  });

  it("handles a deleted source (orphan-remove path) without the throwing helpers", async () => {
    const state = await import("../src/utils/state.js");
    const { compileAndReport } = await import("../src/compiler/index.js");

    await compileAndReport(dir);
    // Delete a source so the next compile runs markOrphaned → draft.removeSource.
    await rm(path.join(dir, "sources", DROP_SOURCE));

    const result = await compileAndReport(dir);

    expect(result.deleted).toBe(1);
    expect(state.updateSourceState).not.toHaveBeenCalled();
    expect(state.removeSourceState).not.toHaveBeenCalled();
    expect((await readPersistedState(dir)).sources[DROP_SOURCE]).toBeUndefined();
  });
});
