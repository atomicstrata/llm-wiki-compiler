/**
 * @file test/products/readiness-skips.test.ts
 * @description Durable explicit skips (AS-1 §4.1: the readiness review "records
 * explicit skips").
 *
 * A SKIP IS RECORDED, NOT HIDDEN, and that distinction is the whole feature.
 * The capability stays LISTED and reports that a person declined it — which
 * differs from "not configured" (nobody has decided) and from omission (nobody
 * can tell it exists). A skip that removed the row would make the review
 * quieter and less true, and months later nobody could separate a deliberate
 * decision from an oversight.
 *
 * AN UNREADABLE RECORD IS NOT AN EMPTY ONE. Treating a corrupt file as "nothing
 * declined" would silently resurrect capabilities the operator already
 * dismissed, and writing over it would destroy every prior decision — so the
 * reader reports it cannot tell and the writer refuses.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRecordedSkips, recordSkip } from "../../src/products/readiness-skips.js";
import { tempRootTracker } from "../temp-roots.js";

const tracker = tempRootTracker();
afterEach(() => tracker.cleanup());

const SKIPS = path.join(".llmwiki", "product-readiness-skips.json");

/** A project root, optionally seeded with a raw skips file. */
async function project(raw?: string): Promise<string> {
  const root = await tracker.create("skips-", { real: true });
  if (raw !== undefined) {
    await mkdir(path.join(root, ".llmwiki"), { recursive: true });
    await writeFile(path.join(root, SKIPS), raw, "utf8");
  }
  return root;
}

describe("recording a skip", () => {
  it("reads an ABSENT record as nothing declined — a definite answer", async () => {
    expect(await readRecordedSkips(await project())).toEqual(new Set());
  });

  it("records a decision and reads it back", async () => {
    const root = await project();
    await recordSkip(root, "model-ready", true);
    expect(await readRecordedSkips(root)).toEqual(new Set(["model-ready"]));
  });

  it("PRESERVES other decisions when recording a new one", async () => {
    const root = await project();
    await recordSkip(root, "first", true);
    await recordSkip(root, "second", true);
    expect(await readRecordedSkips(root)).toEqual(new Set(["first", "second"]));
  });

  it("clears one decision without disturbing the rest", async () => {
    const root = await project();
    await recordSkip(root, "first", true);
    await recordSkip(root, "second", true);
    await recordSkip(root, "first", false);
    expect(await readRecordedSkips(root)).toEqual(new Set(["second"]));
  });
});

describe("an unreadable record", () => {
  it("reads as UNKNOWN, never as nothing declined", async () => {
    expect(await readRecordedSkips(await project("{ not json"))).toBeNull();
  });

  it("reads as unknown when the shape is wrong", async () => {
    expect(await readRecordedSkips(await project('{"skipped":"all"}'))).toBeNull();
  });

  it("REFUSES to be overwritten, so prior decisions are never destroyed", async () => {
    const root = await project("{ not json");
    expect(await recordSkip(root, "model-ready", true)).toBeNull();
    // The corrupt bytes survive: they are a thing to look at, not to replace.
    expect(await readFile(path.join(root, SKIPS), "utf8")).toBe("{ not json");
  });
});
