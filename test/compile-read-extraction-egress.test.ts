/**
 * Security test: a symlinked `wiki/index.md` whose target escapes the project
 * root must NOT have its bytes reach the EXTRACTION provider prompt.
 *
 * The extraction prompt embeds `wiki/index.md` as dedup context. Routing that
 * read through the confined helper means an escaping symlink is dropped and
 * extraction proceeds with an empty index — the captured `toolCall` system
 * prompt (the bytes sent to the provider) never contains the out-of-tree
 * secret. We capture the system prompt by spying on `AnthropicProvider.toolCall`.
 */

import { describe, it, expect, vi } from "vitest";
import { writeFile, symlink } from "fs/promises";
import path from "path";
import { compileAndReport } from "../src/compiler/index.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { makeOutsideDir } from "./fixtures/outside-dir.js";
import { useCompileProject } from "./fixtures/compile-project.js";

const SECRET = "OUTSIDE-INDEX-SECRET-3b91";

describe("extraction provider egress is confined", () => {
  const ctx = useCompileProject({
    dirSuffix: "extraction-egress",
    sourceFile: "source.md",
    sourceContent: "# Source\n\nSome content about a topic.\n",
  });

  it("omits a symlinked wiki/index.md's bytes from the extraction prompt", async () => {
    const outside = await makeOutsideDir();
    const target = path.join(outside, "secret-index.md");
    await writeFile(target, `# Knowledge Wiki\n\n${SECRET}`);
    await symlink(target, path.join(ctx.dir, "wiki", "index.md"));

    const toolCallSpy = vi
      .spyOn(AnthropicProvider.prototype, "toolCall")
      .mockResolvedValue(JSON.stringify({ concepts: [] }));
    vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("body");

    // compileAndReport now rejects in finalizeWiki: generateIndex's confined
    // atomicWrite refuses to write through the symlinked wiki/index.md leaf.
    // The extraction toolCall happens BEFORE finalizeWiki, so the spy already
    // has its calls recorded. Assert the rejection is the EXPECTED confinement
    // error (not some unrelated future throw that would otherwise pass silently).
    await compileAndReport(ctx.dir).catch((err: unknown) => {
      expect(String((err as Error)?.message)).toMatch(/escapes project root|confineRoot|symlink/i);
    });

    const systemPrompts = toolCallSpy.mock.calls.map(([system]) => system);
    expect(systemPrompts.length).toBeGreaterThan(0);
    for (const system of systemPrompts) {
      expect(system).not.toContain(SECRET);
    }
  });
});
