/**
 * @file test/fixtures/seed-pages-harness.ts
 * @description Shared arrange-helpers for `generateSeedPages` tests, so the
 * committed-slug and slug-dedup suites don't duplicate the trust-root lifecycle,
 * the `callClaude` stub, and the empty `PageGenerationResult` builder.
 */

import { beforeEach, afterEach, vi } from "vitest";
import { rm } from "fs/promises";
import * as llm from "../../src/utils/llm.js";
import type { PageGenerationResult } from "../../src/compiler/types.js";
import { makeTrustRoot } from "../trust/fixture.js";

/** Mutable handle to the current test's trust root, set by {@link useSeedPagesRoot}. */
export interface SeedPagesRootCtx {
  /** Absolute path of the current test's trust root. */
  dir: string;
}

/**
 * Register beforeEach/afterEach hooks that create a trust root and stub
 * `callClaude` with a fixed seed body, then clean up. Returns a mutable context
 * whose `dir` each test reads.
 *
 * @param prefix - Short label for the temp directory name.
 * @returns Mutable context with the current `dir`.
 */
export function useSeedPagesRoot(prefix: string): SeedPagesRootCtx {
  const ctx: SeedPagesRootCtx = { dir: "" };
  beforeEach(async () => {
    ctx.dir = await makeTrustRoot(prefix);
    vi.spyOn(llm, "callClaude").mockResolvedValue("## Body\n\nA seed page body.\n");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(ctx.dir, { recursive: true, force: true });
  });
  return ctx;
}

/** An empty generation result whose `seedSlugs`/`errors` a `generateSeedPages` call mutates. */
export function emptyGeneration(): PageGenerationResult {
  return {
    pages: [], writtenPages: [], errors: [], candidates: [],
    review: { held: [], forced: [] }, seedSlugs: [],
  };
}
