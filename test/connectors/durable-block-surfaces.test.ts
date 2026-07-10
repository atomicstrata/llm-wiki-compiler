/**
 * @file test/connectors/durable-block-surfaces.test.ts
 * @description The durable x-llmwiki.connector object survives write gates and read surfaces.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectExportPages } from "../../src/export/collect.js";
import { lint } from "../../src/linter/index.js";
import { promoteStagedEntityPage, stageEntityPage } from "../../src/trust/staging.js";
import { buildViewerSnapshot } from "../../src/viewer/snapshot.js";
import { buildNewsroomProject, NEWSROOM_PROFILE } from "../fixtures/newsroom-profile.js";
import { writeMarkdownPage } from "../fixtures/profile-fixtures.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const root = useTempRoot();
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const BLOCK = {
  connectorId: "fixture",
  connectorVersion: "1",
  sourceUrl: "https://fixture.local/story-1",
  fetchedAt: "2026-07-06T00:00:00.000Z",
  contentHash: HASH_A,
  idempotencyKey: HASH_B,
  externalFields: ["headline"],
};

function connectorBody(): string {
  return [
    "---",
    "headline: Connector Story",
    "stage: draft",
    "aliases:",
    "  - connector story",
    "x-llmwiki.connector:",
    "  connectorId: fixture",
    "  connectorVersion: '1'",
    "  sourceUrl: https://fixture.local/story-1",
    '  fetchedAt: "2026-07-06T00:00:00.000Z"',
    `  contentHash: ${HASH_A}`,
    `  idempotencyKey: ${HASH_B}`,
    "  externalFields:",
    "    - headline",
    "---",
    "Connector body.",
  ].join("\n");
}

async function stageAndPromote(): Promise<void> {
  await buildNewsroomProject(root.dir);
  const staged = await stageEntityPage(root.dir, {
    entityType: "articles",
    slug: "connector-story",
    body: connectorBody(),
    profile: NEWSROOM_PROFILE,
    existingStagedCount: 0,
  });
  await promoteStagedEntityPage(root.dir, staged.id);
}

async function writeDefaultConnectorPage(): Promise<void> {
  const content = connectorBody().replace("headline: Connector Story", "title: Connector Story")
    .replace("stage: draft\n", "");
  await writeMarkdownPage(root.dir, "wiki/concepts", "connector-story", content);
}

describe("durable connector block surfaces", () => {
  it("stages and promotes an unknown object-valued frontmatter block", async () => {
    await stageAndPromote();
    const pagePath = path.join(root.dir, "wiki", "articles", "connector-story.md");
    const page = await readFile(pagePath, "utf8");
    expect(page).toContain("x-llmwiki.connector");
  });

  it("viewer, alias resolution, lint, and export tolerate the object-valued block", async () => {
    await writeDefaultConnectorPage();
    const snapshot = await buildViewerSnapshot(root.dir);
    expect(snapshot.pages.some((p) => p.aliases?.includes("connector story"))).toBe(true);
    await expect(lint(root.dir)).resolves.toBeTruthy();
    const exported = await collectExportPages(root.dir);
    expect(exported.find((p) => p.slug === "connector-story")?.connectorOrigin).toMatchObject(BLOCK);
  });
});
