/**
 * @file test/connectors/event-preflight.test.ts
 * @description Connector staging must fail before candidate-store mutation when its audit event cannot be recorded.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { listCandidates, writeCandidate } from "../../src/compiler/candidates.js";
import { connectorEvent, upperBoundConnectorEvent } from "../../src/connectors/audit.js";
import { MAX_CONNECTOR_URL_BYTES, type ConfinedFetchResult } from "../../src/connectors/confined-fetch.js";
import { runConnector } from "../../src/connectors/run.js";
import { EventStoreFullError } from "../../src/events/types.js";
import type { AppendEventInput } from "../../src/events/store.js";
import { buildNewsroomProject } from "../fixtures/newsroom-profile.js";
import { useTempRoot } from "../fixtures/temp-root.js";

vi.mock("../../src/utils/constants.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/utils/constants.js")>();
  return { ...actual, MAX_EVENT_STORE_BYTES: 220 };
});

const root = useTempRoot();

function fixtureFetch(): Promise<ConfinedFetchResult> {
  return Promise.resolve({
    kind: "ok",
    finalUrl: "https://fixture.local/story-1",
    bytes: Buffer.from("{}", "utf8"),
    contentHash: "a".repeat(64),
  });
}

async function writeConnectorConfig(): Promise<void> {
  const dir = path.join(root.dir, ".llmwiki");
  const fixtureConnector = { contactEmail: "ops@example.com", allowedHosts: ["fixture.local"] };
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "config.json"), JSON.stringify({ connectors: { fixture: fixtureConnector } }), "utf8");
}

describe("connector audit event preflight", () => {
  afterEach(() => {
    delete process.env.LLMWIKI_CONNECTORS;
  });

  it("does not stage a candidate when the connector-fetch event cannot fit", async () => {
    await activateFixtureProject();

    await expectStoreFullBeforeFetch();

    expect(await listCandidates(root.dir)).toHaveLength(0);
  });

  it("does not fetch when the event store cannot take the audit event", async () => {
    await activateFixtureProject();

    await expectStoreFullBeforeFetch();
  });

  it("does not fetch when a multi-candidate supersede event cannot fit", async () => {
    await activateFixtureProject();
    await seedPendingConnectorCandidate("fixture-story-1");
    await seedPendingConnectorCandidate("fixture-story-1-prior");

    await expectStoreFullBeforeFetch();

    expect(await listCandidates(root.dir)).toHaveLength(2);
  });

  it("bounds the pre-fetch estimate above the real staging event", () => {
    const now = (): Date => new Date("2026-07-08T00:00:00.000Z");
    const existingIds = Array.from({ length: 20 }, (_, i) => `fixture-story-1-${String(i).padStart(9, "0")}`);
    const preflightStagedId = `fixture-story-1-${"f".repeat(64)}`;
    const bound = upperBoundConnectorEvent({ id: "fixture", version: "1" }, { existingIds, preflightStagedId }, now);
    const real = connectorEvent({
      provenance: { connectorId: "fixture", connectorVersion: "1" },
      finalUrl: `https://fixture.local/${"y".repeat(MAX_CONNECTOR_URL_BYTES - 22)}`,
      contentHash: "a".repeat(64),
      draftContentHash: "b".repeat(64),
      idempotencyKey: "c".repeat(64),
    }, ["fixture-story-1-abcdef012"], [], existingIds, now);

    expect(eventBytes(bound)).toBeGreaterThanOrEqual(eventBytes(real));
  });
});

/** Serialized size proxy for one event input. */
function eventBytes(event: AppendEventInput): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

/** Install the newsroom project, connector config, and env activation. */
async function activateFixtureProject(): Promise<void> {
  await buildNewsroomProject(root.dir);
  await writeConnectorConfig();
  process.env.LLMWIKI_CONNECTORS = "fixture";
}

/** Assert the run rejects with a full event store before any fetch is dialed. */
async function expectStoreFullBeforeFetch(): Promise<void> {
  let fetches = 0;
  await expect(
    runConnector(root.dir, "fixture", { id: "story-1" }, {
      fetcher: async () => {
        fetches += 1;
        return fixtureFetch();
      },
    }),
  ).rejects.toBeInstanceOf(EventStoreFullError);
  expect(fetches).toBe(0);
}

/** Seed one pending candidate carrying the fixture story-1 idempotency key in its sidecar. */
async function seedPendingConnectorCandidate(slug: string): Promise<void> {
  await writeCandidate(root.dir, {
    title: "story-1",
    slug,
    summary: "",
    sources: [],
    body: "---\nheadline: Story\nstage: draft\n---\nSeeded pending candidate",
    reviewMode: "connector",
    heldReasons: [{ code: "connector-fetched" }],
    targetEntityType: "articles",
    connectorProvenance: {
      connectorId: "fixture",
      connectorVersion: "1",
      sourceUrl: "https://fixture.local/story-1",
      fetchedAt: "2026-07-08T00:00:00.000Z",
      contentHash: "b".repeat(64),
      draftContentHash: "d".repeat(64),
      idempotencyKey: createHash("sha256").update("fixture\nstory-1").digest("hex"),
    },
  });
}
