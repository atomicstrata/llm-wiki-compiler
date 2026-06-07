/**
 * Viewer snapshot freshness integration tests.
 *
 * Verifies that `buildViewerSnapshot` attaches computed `PageFreshness` to
 * each page (via `computeFreshness`) and surfaces aggregate stale/orphaned
 * counts in `ViewerCounts`. Also confirms that the snapshot uses the
 * read-only `readStateClassified` path so corrupt state never produces a
 * `.bak` side-effect.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "fs";
import { rm } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import {
  sha256Hex,
  writeSourceFile,
  writeSourceState,
  writeCorruptTestStateJson,
} from "./fixtures/state-json.js";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";

let root: string;

beforeEach(async () => {
  root = await makeTempRoot("freshness-viewer");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write a minimal concept page named "topic" into the temp root. */
async function writeTopic(r: string) {
  await writePage(path.join(r, CONCEPTS_DIR), "topic", { title: "Topic" }, "Body.");
}

/** Build snapshot and find the "topic" page in one step. */
async function buildAndFind(r: string) {
  const snap = await buildViewerSnapshot(r);
  return { snap, page: snap.pages.find((p) => p.slug === "topic") };
}

describe("viewer snapshot freshness", () => {
  it("marks a page fresh when its source exists and the hash matches", async () => {
    // State records a.md owning "topic" with the hash of the on-disk content.
    await writeSourceState(root, { "a.md": { hash: sha256Hex("body"), concepts: ["topic"] } });
    await writeSourceFile(root, "a.md", "body");
    await writeTopic(root);

    const { snap, page } = await buildAndFind(root);

    expect(page?.freshness.freshnessStatus).toBe("fresh");
    expect(snap.counts.stale).toBe(0);
    expect(snap.counts.orphaned).toBe(0);
  });

  it("marks a page stale when its source changed", async () => {
    // State records a.md with OLD hash owning "topic", but disk has NEW content.
    await writeSourceState(root, { "a.md": { hash: sha256Hex("OLD body"), concepts: ["topic"] } });
    await writeSourceFile(root, "a.md", "NEW body");
    await writeTopic(root);

    const { snap, page } = await buildAndFind(root);

    expect(page?.freshness.freshnessStatus).toBe("stale");
    expect(snap.counts.stale).toBe(1);
    expect(snap.counts.orphaned).toBe(0);
  });

  it("marks a page orphaned when all owning sources are deleted", async () => {
    // State records a.md owning "topic" but the source file does not exist.
    await writeSourceState(root, { "a.md": { hash: "xyz", concepts: ["topic"] } });
    await writeTopic(root);

    const { snap, page } = await buildAndFind(root);

    expect(page?.freshness.freshnessStatus).toBe("orphaned");
    expect(snap.counts.orphaned).toBe(1);
    expect(snap.counts.stale).toBe(0);
  });

  it("writes no .bak on corrupt state and marks pages unverified", async () => {
    await writeTopic(root);
    await writeCorruptTestStateJson(root);

    const { snap, page } = await buildAndFind(root);

    expect(page?.freshness.freshnessStatus).toBe("unverified");
    expect(existsSync(path.join(root, ".llmwiki/state.json.bak"))).toBe(false);
  });
});
