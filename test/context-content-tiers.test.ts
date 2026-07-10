/**
 * @file test/context-content-tiers.test.ts
 * @description Generic per-record content-depth projection (`contentTiers`) in the
 * `llmwiki context` pack. A non-default entity type that declares `contentTiers`
 * reveals each ranked record's tiers shallowest-first WITHIN that record; a tight
 * budget drops the deepest tiers first; a default project (or a type without the
 * key) emits NO `contentTiers` key at all. The engine speaks only field names +
 * the reserved `body` token — this suite is structurally NON-research to prove it.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildContextPack } from "../src/context/build.js";
import { writeProfileFile, writeMarkdownPage } from "./fixtures/profile-fixtures.js";
import type { ProfilePack } from "../src/profile/types.js";

/** A structurally-generic `widgets` profile whose three fields are its tiers. */
const WIDGETS_PROFILE = {
  schemaVersion: 1,
  profileId: "widgets-test",
  entities: {
    widgets: {
      directory: "wiki/widgets",
      fields: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
      contentTiers: ["a", "b", "c"],
    },
  },
} as unknown as ProfilePack;

const PROMPT = "ZorbleWidget";
const WIDGET_ID = "widgets/gizmo";

/** Seed a widgets project; frontmatter is caller-controlled so tiers can be sparse. */
async function seedWidget(root: string, frontmatter: string): Promise<void> {
  await writeProfileFile(root, WIDGETS_PROFILE);
  await writeMarkdownPage(root, "wiki/widgets", "gizmo", `---\n${frontmatter}\n---\nZorbleWidget distinctive body.`);
}

/** The widget's primary entry for the standard prompt at `budget` tokens. */
async function widgetPrimary(root: string, budget?: number) {
  const pack = await buildContextPack({ root, prompt: PROMPT, budget });
  return { pack, primary: pack.primary.find((p) => (p.id as unknown as string) === WIDGET_ID) };
}

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "content-tiers-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("contentTiers — shallowest-first per-record projection", () => {
  it("reveals declared tiers in order with each field's value as content", async () => {
    await seedWidget(root, "a: Alpha\nb: Beta\nc: Gamma");
    const { primary } = await widgetPrimary(root);
    const tiers = primary?.contentTiers ?? [];
    const names = tiers.map((t) => t.tier);
    expect(names.indexOf("a")).toBeLessThan(names.indexOf("c"));
    expect(tiers).toEqual([
      { tier: "a", content: "Alpha" },
      { tier: "b", content: "Beta" },
      { tier: "c", content: "Gamma" },
    ]);
  });

  it("silently skips a declared tier the record does not populate", async () => {
    await seedWidget(root, "a: Alpha\nc: Gamma");
    const { primary } = await widgetPrimary(root);
    const names = (primary?.contentTiers ?? []).map((t) => t.tier);
    expect(names).toEqual(["a", "c"]);
  });
});

describe("contentTiers — default-profile parity", () => {
  it("emits NO contentTiers key for a default project's primaries", async () => {
    await writeMarkdownPage(root, "wiki/concepts", "zorblewidget", "# ZorbleWidget\n\nZorbleWidget concept body.");
    const { pack } = await widgetPrimary(root);
    expect(pack.primary.length).toBeGreaterThan(0);
    for (const entry of pack.primary) expect(entry.contentTiers).toBeUndefined();
  });

  it("emits NO contentTiers key for a non-default type that omits the field", async () => {
    const mixed = {
      schemaVersion: 1,
      profileId: "mixed-test",
      entities: {
        widgets: { directory: "wiki/widgets", fields: { a: { type: "string" } }, contentTiers: ["a"] },
        gadgets: { directory: "wiki/gadgets", fields: { a: { type: "string" } } },
      },
    } as unknown as ProfilePack;
    await writeProfileFile(root, mixed);
    await writeMarkdownPage(root, "wiki/widgets", "gizmo", "---\na: Alpha\n---\nZorbleWidget widget body.");
    await writeMarkdownPage(root, "wiki/gadgets", "sprocket", "---\na: Alpha\n---\nZorbleWidget gadget body.");
    const pack = await buildContextPack({ root, prompt: PROMPT });
    const widget = pack.primary.find((p) => (p.id as unknown as string) === "widgets/gizmo");
    const gadget = pack.primary.find((p) => (p.id as unknown as string) === "gadgets/sprocket");
    expect(widget?.contentTiers).toBeDefined();
    expect(gadget?.contentTiers).toBeUndefined();
  });
});

describe("contentTiers — the body tier is capped and fenced as untrusted", () => {
  /** A `widgets` profile whose tiers are a short field then the reserved body token. */
  const BODY_PROFILE = {
    schemaVersion: 1,
    profileId: "body-test",
    entities: { widgets: { directory: "wiki/widgets", fields: { a: { type: "string" } }, contentTiers: ["a", "body"] } },
  } as unknown as ProfilePack;

  it("bounds an oversize page body and marks it as data, not instructions", async () => {
    await writeProfileFile(root, BODY_PROFILE);
    const longBody = `ZorbleWidget ${"X".repeat(20000)}`;
    await writeMarkdownPage(root, "wiki/widgets", "gizmo", `---\na: Alpha\n---\n${longBody}`);
    const { primary } = await widgetPrimary(root, 1_000_000);
    const body = (primary?.contentTiers ?? []).find((t) => t.tier === "body");
    expect(body).toBeDefined();
    expect(body?.content).toContain("untrusted"); // fenced as untrusted content
    expect(body?.content).toContain("truncated"); // over-cap body is bounded
    expect(body?.content.length).toBeLessThan(longBody.length);
  });
});

describe("contentTiers — budget drops the deepest tier first", () => {
  it("drops tier c under a tight budget while shallow tier a survives", async () => {
    // A long deepest tier (~200 tokens) so removing it ALONE clears the overage.
    await seedWidget(root, `a: Alpha\nb: Beta\nc: ${"G".repeat(800)}`);
    const full = await widgetPrimary(root, 1_000_000);
    expect((full.primary?.contentTiers ?? []).map((t) => t.tier)).toEqual(["a", "b", "c"]);
    // Over budget by ~40 tokens — far less than tier c's weight, so only c drops.
    const tight = await widgetPrimary(root, full.pack.budget.estimatedTokens - 40);
    const names = (tight.primary?.contentTiers ?? []).map((t) => t.tier);
    expect(names).toContain("a");
    expect(names).not.toContain("c");
    expect(tight.pack.budget.trimmedSections).toContain("contentTiers");
  });

  it("drops ALL tiers under a very tight budget, leaving the key ABSENT (not [])", async () => {
    // Three heavy tiers (~200 tokens each); an overage between (b+c) and (a+b+c)
    // forces every tier to drop while the primary itself survives.
    await seedWidget(root, `a: ${"A".repeat(800)}\nb: ${"B".repeat(800)}\nc: ${"C".repeat(800)}`);
    const full = await widgetPrimary(root, 1_000_000);
    expect((full.primary?.contentTiers ?? []).length).toBe(3);
    const tiny = await widgetPrimary(root, full.pack.budget.estimatedTokens - 500);
    expect(tiny.primary).toBeDefined();
    expect(tiny.primary?.contentTiers).toBeUndefined();
    expect(tiny.pack.budget.trimmedSections).toContain("contentTiers");
  });
});
