/**
 * @file test/scale/downgrade-interruption.test.ts
 * @description Interruption witnesses of an indexed scale-down on real disk.
 * For each durable checkpoint (the intent, the fence, a complete staging
 * attempt, a rename before its directory syncs, the installation, the archive
 * rename before its syncs, the archive, the receipt and the activation), a
 * child applying the plan EXITS there, as a killed process would; then the
 * SAME plan applied by a fresh process resumes and completes: the logical
 * content read through the ordinary routes equals the content before, the
 * record is version 1 with the target active, the indexed stores are archived
 * and the intent retired. The resume reports `resumed`.
 */

import { describe, expect, it } from "bun:test";
import { CASE_TIMEOUT_MS, crashAt, expectCompleted, ok, planFileFor, useDowngradeProjects } from "./downgrade-helpers.js";

const projects = useDowngradeProjects();

/** The checkpoints a kill is witnessed at. */
const SEAMS = [
  "after-intent", "after-fence", "after-stage", "rename:wiki/graph/events.jsonl", "after-install",
  "rename:.llmwiki/indexed", "after-archive", "after-receipt", "after-activation",
] as const;

describe("a scale-down killed at a durable checkpoint", () => {
  it.each(SEAMS)("resumes and completes after a kill at %s", async (seam) => {
    const root = await projects.build("build");
    const before = await ok<Record<string, unknown>>("snapshot", root);
    await ok("preview", root, "local-standard", "100", planFileFor(root));
    await crashAt(root, planFileFor(root), seam);
    const resumed = await ok<{ resumed: boolean; target: string }>("apply", root, planFileFor(root));
    expect([resumed.resumed, resumed.target]).toEqual([true, "local-standard"]);
    await expectCompleted(root, before);
  }, CASE_TIMEOUT_MS);
});
