/**
 * Integration tests for freshness fields on `ContextPrimary`.
 *
 * Verifies that `buildContextPack` copies `PageFreshness` signals onto each
 * primary page entry and synthesizes a `stale-page` warning when the
 * underlying source has changed since the last compile. Stale pages are
 * flagged — never dropped.
 *
 * Fixture pattern: write a concept page + matching source state so the
 * viewer snapshot carries a deterministic `freshnessStatus`, then assert
 * the context pack reflects it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { sha256Hex, writeSourceFile, writeSourceState } from "./fixtures/state-json.js";
import { buildContextPack } from "../src/context/build.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";

let root: string;

beforeEach(async () => {
  root = await makeTempRoot("freshness-context");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Write a concept page with a title and body that will rank against the
 * prompt "topic" via title-match and exact-title signals.
 */
async function writeTopic(): Promise<void> {
  await writePage(
    path.join(root, CONCEPTS_DIR),
    "topic",
    { title: "Topic", summary: "The topic page" },
    "A topic page body.",
  );
}

/** Seed a fresh fixture: source on disk matches the recorded hash. */
async function seedFresh(): Promise<void> {
  const sourceContent = "source body";
  await writeSourceState(root, {
    "a.md": { hash: sha256Hex(sourceContent), concepts: ["topic"] },
  });
  await writeSourceFile(root, "a.md", sourceContent);
  await writeTopic();
}

/**
 * Build a context pack for "topic" and return the primary entry for
 * `concepts/topic`, or `undefined` when the page did not rank.
 */
async function packPrimary() {
  const pack = await buildContextPack({ root, prompt: "topic", topPages: 5 });
  return pack.primary.find((p) => p.id === "concepts/topic");
}

describe("context pack freshness", () => {
  it("carries freshnessStatus=fresh onto a primary page whose source matches", async () => {
    await seedFresh();

    const primary = await packPrimary();

    expect(primary).toBeDefined();
    expect(primary?.freshnessStatus).toBe("fresh");
    expect(primary?.contradicted).toBe(false);
    expect(primary?.archived).toBe(false);
  });

  it("flags a stale primary page (never drops it) and adds stale-page warning", async () => {
    // State records OLD hash; disk has NEW content → stale
    await writeSourceState(root, {
      "a.md": { hash: sha256Hex("OLD body"), concepts: ["topic"] },
    });
    await writeSourceFile(root, "a.md", "NEW body");
    await writeTopic();

    const primary = await packPrimary();

    expect(primary).toBeDefined();
    expect(primary?.freshnessStatus).toBe("stale");
    expect(primary?.warnings.some((w) => w.code === "stale-page")).toBe(true);
  });

  it("does not add stale-page warning on a fresh page", async () => {
    await seedFresh();

    const primary = await packPrimary();

    expect(primary?.warnings.some((w) => w.code === "stale-page")).toBe(false);
  });

  it("carries freshnessStatus=unverified when state.json is missing", async () => {
    // No writeSourceState call → state is missing → unverified
    await writeTopic();

    const primary = await packPrimary();

    expect(primary).toBeDefined();
    expect(primary?.freshnessStatus).toBe("unverified");
    expect(primary?.warnings.some((w) => w.code === "stale-page")).toBe(false);
  });

  it("adds contradicted-page warning on a contradicted primary page", async () => {
    await seedFresh();
    // Overwrite the page with contradictedBy frontmatter.
    await writePage(
      path.join(root, CONCEPTS_DIR),
      "topic",
      { title: "Topic", summary: "The topic page", contradictedBy: [{ slug: "other" }] },
      "A topic page body.",
    );

    const primary = await packPrimary();

    expect(primary).toBeDefined();
    expect(primary?.contradicted).toBe(true);
    expect(primary?.warnings.some((w) => w.code === "contradicted-page")).toBe(true);
  });

  it("adds archived-page warning on an archived primary page", async () => {
    await seedFresh();
    // Overwrite the page with archived frontmatter.
    await writePage(
      path.join(root, CONCEPTS_DIR),
      "topic",
      { title: "Topic", summary: "The topic page", archived: true },
      "A topic page body.",
    );

    const primary = await packPrimary();

    expect(primary).toBeDefined();
    expect(primary?.archived).toBe(true);
    expect(primary?.warnings.some((w) => w.code === "archived-page")).toBe(true);
  });

  it("does not add contradicted-page or archived-page warning on a fresh, non-contradicted, non-archived page", async () => {
    await seedFresh();

    const primary = await packPrimary();

    expect(primary?.warnings.some((w) => w.code === "contradicted-page")).toBe(false);
    expect(primary?.warnings.some((w) => w.code === "archived-page")).toBe(false);
  });

  it("carries BOTH stale-page and contradicted-page warnings on a stale+contradicted page", async () => {
    // State records OLD hash; disk has NEW content → stale.
    await writeSourceState(root, {
      "a.md": { hash: sha256Hex("OLD body"), concepts: ["topic"] },
    });
    await writeSourceFile(root, "a.md", "NEW body");
    // Page frontmatter marks it contradicted.
    await writePage(
      path.join(root, CONCEPTS_DIR),
      "topic",
      { title: "Topic", summary: "The topic page", contradictedBy: [{ slug: "other" }] },
      "A topic page body.",
    );

    const primary = await packPrimary();

    expect(primary?.freshnessStatus).toBe("stale");
    expect(primary?.contradicted).toBe(true);
    expect(primary?.warnings.some((w) => w.code === "stale-page")).toBe(true);
    expect(primary?.warnings.some((w) => w.code === "contradicted-page")).toBe(true);
  });
});
