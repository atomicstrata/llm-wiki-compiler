/**
 * @file test/compile-refresh-watch-reroute.test.ts
 * @description (M6) refresh/watch coverage + (group 6) seed↔generated slug
 * collision for the compile reroute.
 *
 * (M6) refresh and a watch tick BOTH enter through `compile()`, so they inherit
 * the SAME reroute guarantees as a direct compile: the strict pre-compile
 * {@link recoverJournalBeforeCompile} runs, page writes route through the
 * executor adapter ({@link applyCompilePageWritesLocked}), and the journal is
 * left bounded (empty) afterward.
 *  - `refreshCommand` is driven directly (it resolves `process.cwd()`, so the
 *    test chdirs into the project root and restores it after).
 *  - `watch`'s tick calls `compile(process.cwd(), …)`; the task permits driving
 *    that underlying compile call, so the watch case drives `compile()` directly.
 *
 * (group 6) seed↔generated slug collision: a seed page whose slug EQUALS a
 * generated concept slug. The seed batch is applied AFTER generation commits, so
 * today's precedence is "seed overwrites the generated page". This pins that
 * byte-for-byte (the final on-disk page is the seed body, not the concept body).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { compile } from "../src/compiler/index.js";
import refreshCommand from "../src/commands/refresh.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";
import * as recovery from "../src/trust/journal-recovery.js";
import * as compileWrite from "../src/compiler/compile-write.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import { writeSourceState, sha256Hex } from "./fixtures/state-json.js";
import {
  journalFileCount,
  stubExtractionAndBody,
  writeOverviewSeedSchema,
} from "./fixtures/compile-reroute-helpers.js";

const ctx = useCompileProject({
  dirSuffix: "refresh-watch-reroute",
  sourceFile: "alpha.md",
  sourceContent: "# Alpha\n\nAbout Alpha.",
});

/** Stub extraction (one concept) + a fixed body; silence logs. */
function stubAlpha(body = "Alpha body content here."): void {
  stubExtractionAndBody("Alpha", body);
}

/** Seed a stale compiled state for `alpha.md` so refresh treats it as stale. */
async function seedStaleState(): Promise<void> {
  await mkdir(path.join(ctx.dir, CONCEPTS_DIR), { recursive: true });
  const fm = "---\ntitle: Alpha\nsummary: s\nsources: [alpha.md]\n---";
  await writeFile(path.join(ctx.dir, CONCEPTS_DIR, "alpha.md"), `${fm}\n\nOld alpha body.\n`, "utf-8");
  // State records a DIFFERENT hash than the current source → the page is stale.
  await writeSourceState(ctx.dir, { "alpha.md": { hash: sha256Hex("stale"), concepts: ["alpha"] } });
}

let prevCwd = "";
afterEach(() => {
  if (prevCwd) process.chdir(prevCwd);
  prevCwd = "";
});

describe("M6: refresh enters through compile() with the reroute guarantees", () => {
  it("refresh runs strict recovery, routes through the executor, leaves an empty journal", async () => {
    await seedStaleState();
    stubAlpha("Refreshed alpha body.");
    const recoverSpy = vi.spyOn(recovery, "recoverJournalBeforeCompile");
    const applySpy = vi.spyOn(compileWrite, "applyCompilePageWritesLocked");

    prevCwd = process.cwd();
    process.chdir(ctx.dir);
    const code = await refreshCommand({ stale: true });

    expect(code).toBe(0);
    expect(recoverSpy).toHaveBeenCalled();
    // The stale page's recompile went through the executor adapter, not a direct write.
    expect(applySpy.mock.calls.some((c) => (c[1] as { slug: string }[]).some((w) => w.slug === "alpha"))).toBe(true);
    expect(await journalFileCount(ctx.dir)).toBe(0);
    expect(await readFile(path.join(ctx.dir, CONCEPTS_DIR, "alpha.md"), "utf-8")).toContain("Refreshed alpha body.");
  });
});

describe("M6: a watch tick enters through compile() with the reroute guarantees", () => {
  it("the compile a watch tick runs gets strict recovery + executor + bounded journal", async () => {
    stubAlpha();
    const recoverSpy = vi.spyOn(recovery, "recoverJournalBeforeCompile");
    const applySpy = vi.spyOn(compileWrite, "applyCompilePageWritesLocked");

    // watch's runCompileOnce calls compile(process.cwd(), { concurrency }); drive it.
    await compile(ctx.dir, { concurrency: 1 });

    expect(recoverSpy).toHaveBeenCalled();
    expect(applySpy).toHaveBeenCalled();
    expect(existsSync(path.join(ctx.dir, CONCEPTS_DIR, "alpha.md"))).toBe(true);
    expect(await journalFileCount(ctx.dir)).toBe(0);
  });
});

describe("group 6: seed slug colliding with a generated concept slug", () => {
  it("the seed batch (applied after generation) overwrites the generated page", async () => {
    // Schema declares a seed titled "Alpha" → seed slug `alpha` == generated slug.
    await writeOverviewSeedSchema(ctx.dir, "Alpha");

    // Distinguish the two bodies: generation emits "GENERATED", the seed "SEEDED".
    vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(
      JSON.stringify({ concepts: [{ concept: "Alpha", summary: "Alpha summary.", is_new: true, confidence: 0.9 }] }),
    );
    const bodies = ["GENERATED concept body for Alpha.", "SEEDED overview body for Alpha."];
    let call = 0;
    vi.spyOn(AnthropicProvider.prototype, "complete").mockImplementation(async () => bodies[Math.min(call++, 1)]);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await compile(ctx.dir);

    // Today's precedence: seed (later batch) wins — the on-disk page is the seed body.
    const final = await readFile(path.join(ctx.dir, CONCEPTS_DIR, "alpha.md"), "utf-8");
    expect(final).toContain("SEEDED overview body for Alpha.");
    expect(final).not.toContain("GENERATED concept body for Alpha.");
    expect(await journalFileCount(ctx.dir)).toBe(0);
  });
});
