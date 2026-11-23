/**
 * @file test/scale-measure/build-marker.test.ts
 * @description Ops-only measurements refuse a marker from a different source
 * revision or a replaced corpus directory before invoking measurement children.
 */

import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "bun:test";
import { runMeasurements } from "./run.js";

/** Build the zero-document fixture and return its marker and corpus paths. */
async function builtFixture(base: string): Promise<{ marker: string; corpus: string }> {
  const work = path.join(base, "work");
  await runMeasurements(path.join(base, "build.json"), [["calibration", 0]], work, "build");
  return { marker: path.join(work, "calibration-0.built.json"), corpus: path.join(work, "calibration-0") };
}

/** Change one completed build and require the ops stage to refuse it. */
async function refuseChangedBuild(change: (base: string, built: { marker: string; corpus: string }) => Promise<void>): Promise<void> {
  const base = await mkdtemp(path.join(tmpdir(), "llmwiki-marker-changed-"));
  try {
    const built = await builtFixture(base);
    await change(base, built);
    await expect(runMeasurements(path.join(base, "ops.json"), [["calibration", 0]], path.join(base, "work"), "ops"))
      .rejects.toThrow("build marker");
  } finally { await rm(base, { recursive: true, force: true }); }
}

it("refuses ops-only when the build marker names another source tree", async () => {
  await refuseChangedBuild(async (_base, { marker }) => {
    const recorded = JSON.parse(await readFile(marker, "utf8")) as Record<string, unknown>;
    await writeFile(marker, JSON.stringify({ ...recorded, source: { head: "other-head", uncommittedTreeSha256: "other-tree" } }));
  });
}, 30_000);

it("refuses ops-only when the corpus directory was replaced", async () => {
  await refuseChangedBuild(async (base, { corpus }) => {
    const replacement = path.join(base, "replacement");
    await mkdir(replacement);
    await rename(corpus, path.join(base, "old-corpus"));
    await rename(replacement, corpus);
  });
}, 30_000);

it("accepts ops-only for the completed corpus and unchanged source", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "llmwiki-marker-valid-"));
  try {
    await builtFixture(base);
    const result = await runMeasurements(path.join(base, "ops.json"), [["calibration", 0]], path.join(base, "work"), "ops");
    expect((result.entries as unknown[]).length).toBe(1);
  } finally { await rm(base, { recursive: true, force: true }); }
}, 30_000);
