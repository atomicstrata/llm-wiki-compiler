/**
 * @file test/compile-floor-proof.test.ts
 * @description C2 FLOOR PROOF for the compile reroute: every body compile submits
 * to the planner — across ALL applying sites (generation, deletion-orphan,
 * frozen-orphan, seed, resolution) — composes to `allow`/`allow-with-warning`
 * under {@link runMandatoryPageChecks} with the COMPILE resource cap
 * ({@link resourceCapForOrigin}({@link COMPILE_ORIGIN})).
 *
 * Strategy: spy {@link applyCompilePageWritesLocked} to CAPTURE every
 * `CompilePageWrite` compile actually hands to the executor (grouped by call
 * site, in pipeline order), then re-run the mandatory floor against each body
 * with the compile cap + `allowOverwrite:true` (compile recompiles existing
 * pages) and assert each composes to a live-write decision. A GOLDEN body that
 * failed the floor would be a real reconcile-before-shipping gap — the run would
 * fail loudly here rather than silently skip the page at compile time.
 *
 * Two fixtures drive it: the simple single-source project, and a regression
 * TRAP — a merged body SIZED between the single-source cap and the compile cap
 * (`MAX_SOURCE_CHARS < len < GENERATED_PAGE_MAX_CHARS`). That body composes to
 * `allow` ONLY because the compile cap applies; it would `deny` under the
 * single-source cap, so the test FAILS if `resourceCapForOrigin` ever regressed
 * to return `MAX_SOURCE_CHARS` for the compile origin.
 */

import { describe, it, expect, vi } from "vitest";
import { writeFile } from "fs/promises";
import path from "path";
import { compileAndReport } from "../src/compiler/index.js";
import { CONCEPTS_DIR, MAX_SOURCE_CHARS, GENERATED_PAGE_MAX_CHARS } from "../src/utils/constants.js";
import { buildFrontmatter } from "../src/utils/markdown.js";
import * as compileWrite from "../src/compiler/compile-write.js";
import type { CompilePageWrite } from "../src/compiler/compile-write.js";
import { runMandatoryPageChecks, resourceCapForOrigin, COMPILE_ORIGIN } from "../src/trust/checks.js";
import { composeTrustDecision } from "../src/trust/decision.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import {
  stubExtractionAndBody,
  writeOverviewSeedSchema,
  writeSingleOwnerState,
} from "./fixtures/compile-reroute-helpers.js";

const ctx = useCompileProject({
  dirSuffix: "floor-proof",
  sourceFile: "alpha.md",
  sourceContent: "# Alpha\n\nAlpha relates to Beta.",
});

/** Decisions under which the executor is cleared to write bytes. */
const LIVE = new Set(["allow", "allow-with-warning"]);

/** Spy the executor seam and collect EVERY captured write across all its calls. */
function captureCompileWrites(): { writes: CompilePageWrite[] } {
  const writes: CompilePageWrite[] = [];
  const real = compileWrite.applyCompilePageWritesLocked;
  vi.spyOn(compileWrite, "applyCompilePageWritesLocked").mockImplementation(
    async (root, items, opts) => {
      writes.push(...items);
      return real(root, items, opts);
    },
  );
  return { writes };
}

/** Re-run the mandatory floor against a body under an explicit char cap. */
async function floorDecisionWithCap(root: string, body: string, maxBodyChars: number): Promise<string> {
  const checks = await runMandatoryPageChecks({
    root,
    targetPath: path.join(CONCEPTS_DIR, "floor-probe.md"),
    body,
    allowOverwrite: true,
    maxBodyChars,
  });
  return composeTrustDecision(checks, { reviewRouted: false });
}

/** The decision compile itself would reach: the floor under the COMPILE origin cap. */
function floorDecision(root: string, body: string): Promise<string> {
  return floorDecisionWithCap(root, body, resourceCapForOrigin(COMPILE_ORIGIN));
}

describe("C2 floor proof — every submitted compile body plans to allow", () => {
  it("generation + deletion-orphan + seed + resolution bodies all clear the floor", async () => {
    // A deleted-source-owned page → deletion-orphan; a seed page; link-bearing gen.
    const fm = buildFrontmatter({ title: "Beta", summary: "s", sources: ["beta.md"] });
    await writeFile(path.join(ctx.dir, CONCEPTS_DIR, "beta.md"), `${fm}\n\nBeta body.\n`, "utf-8");
    await writeSingleOwnerState(ctx.dir, "beta.md", "beta");
    await writeOverviewSeedSchema(ctx.dir);
    stubExtractionAndBody("Gamma", "Gamma body mentioning Beta and Alpha here.");

    const { writes } = captureCompileWrites();
    const result = await compileAndReport(ctx.dir);
    expect(result.errors).toEqual([]);

    // At minimum the orphan, generation, and seed sites each submitted a body.
    expect(writes.length).toBeGreaterThanOrEqual(3);
    for (const w of writes) {
      const decision = await floorDecision(ctx.dir, w.body);
      expect(LIVE.has(decision), `site ${w.namespace}/${w.slug} → ${decision}`).toBe(true);
    }
  });
});

describe("C2 floor proof — compile cap regression trap (large merged body)", () => {
  it("a body over the single-source cap but under the compile cap allows ONLY at the compile cap", async () => {
    // A merged concept body sized strictly between the two caps. This is a real
    // regression trap: it clears the floor solely BECAUSE the compile origin maps
    // to GENERATED_PAGE_MAX_CHARS — so the test fails if that mapping regresses.
    const len = MAX_SOURCE_CHARS + 10_000;
    expect(len).toBeGreaterThan(MAX_SOURCE_CHARS);
    expect(len).toBeLessThan(GENERATED_PAGE_MAX_CHARS);
    const body = `---\ntitle: Merged\nsummary: s\nsources: [a.md, b.md]\n---\n\n${"x ".repeat(len / 2)}`;

    // The decision compile actually reaches (COMPILE origin cap) → allow.
    expect(LIVE.has(await floorDecision(ctx.dir, body))).toBe(true);
    // If resourceCapForOrigin regressed to the single-source cap, this same body
    // would be denied — pinning that the COMPILE cap is what admits it.
    expect(await floorDecisionWithCap(ctx.dir, body, MAX_SOURCE_CHARS)).toBe("deny");
  });
});
