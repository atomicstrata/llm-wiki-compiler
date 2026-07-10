/**
 * @file test/connectors/run-substrate.test.ts
 * @description Connector substrate maps fetched data into typed review candidates.
 */
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listCandidates } from "../../src/compiler/candidates.js";
import { readConnectorBlock } from "../../src/connectors/fence.js";
import type { ConfinedFetchResult } from "../../src/connectors/confined-fetch.js";
import type { ConnectorRequest } from "../../src/connectors/types.js";
import { runConnector } from "../../src/connectors/run.js";
import { readEvents } from "../../src/events/store-read.js";
import { acquireLock, releaseLock } from "../../src/utils/lock.js";
import { parseFrontmatter } from "../../src/utils/markdown.js";
import { buildNewsroomProject } from "../fixtures/newsroom-profile.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const root = useTempRoot();
const CONTENT_HASH_A = "a".repeat(64);
const CONTENT_HASH_B = "b".repeat(64);

function fixtureFetch(contentHash = CONTENT_HASH_A): Promise<ConfinedFetchResult> {
  return Promise.resolve({
    kind: "ok",
    finalUrl: "https://fixture.local/story-1",
    bytes: Buffer.from("{}", "utf8"),
    contentHash,
  });
}

async function writeConnectorConfig(contactEmail = "ops@example.com", minRequestIntervalMs?: number): Promise<void> {
  const dir = path.join(root.dir, ".llmwiki");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "config.json"), JSON.stringify({
    connectors: { fixture: { contactEmail, allowedHosts: ["fixture.local"], minRequestIntervalMs } },
  }), "utf8");
}

/** Install the fixture profile, connector config, and env activation used by substrate tests. */
async function activateFixtureConnector(contactEmail = "ops@example.com", minRequestIntervalMs?: number): Promise<void> {
  await buildNewsroomProject(root.dir);
  await writeConnectorConfig(contactEmail, minRequestIntervalMs);
  process.env.LLMWIKI_CONNECTORS = "fixture";
}

/** Stage the fixture connector for the common story id. */
function runFixtureConnector(contentHash = CONTENT_HASH_A) {
  return runConnector(root.dir, "fixture", { id: "story-1" }, { fetcher: () => fixtureFetch(contentHash) });
}

/** The single staged candidate id from a run result. */
function stagedId(result: Awaited<ReturnType<typeof runConnector>>): string {
  return result.kind === "staged" ? result.candidateIds[0] ?? "" : "";
}

/** Assert exactly one pending candidate remains and return its id. */
async function onlyCandidateId(): Promise<string | undefined> {
  const candidates = await listCandidates(root.dir);
  expect(candidates).toHaveLength(1);
  return candidates[0]?.id;
}

/** Copy a pending candidate under a second id sharing the same idempotency key. */
async function seedDuplicatePendingCandidate(id: string): Promise<string> {
  const dir = path.join(root.dir, ".llmwiki", "candidates");
  const raw = JSON.parse(await readFile(path.join(dir, `${id}.json`), "utf8"));
  const dupId = `${id}0`;
  raw.id = dupId;
  await writeFile(path.join(dir, `${dupId}.json`), JSON.stringify(raw, null, 2), "utf8");
  return dupId;
}

describe("runConnector", () => {
  afterEach(() => {
    delete process.env.LLMWIKI_CONNECTORS;
  });

  it("refuses when env activation is absent", async () => {
    await buildNewsroomProject(root.dir);
    const result = await runConnector(root.dir, "fixture", { id: "story-1" });
    expect(result.kind).toBe("refused");
    expect(await listCandidates(root.dir)).toHaveLength(0);
  });

  it("stages one typed connector candidate with host-authored provenance", async () => {
    await activateFixtureConnector();
    const result = await runFixtureConnector();
    expect(result.kind).toBe("staged");
    const [candidate] = await listCandidates(root.dir);
    expect(candidate?.reviewMode).toBe("connector");
    expect(candidate?.connectorProvenance?.connectorId).toBe("fixture");
    expect(candidate?.body).toContain("x-llmwiki.connector");
    const { meta } = parseFrontmatter(candidate!.body);
    expect(readConnectorBlock(meta)?.externalFields).toEqual(["headline", "stage"]);
  });

  it("uses the configured contentField as the candidate body prose", async () => {
    await activateFixtureConnector();
    await runFixtureConnector();

    const [candidate] = await listCandidates(root.dir);
    expect(candidate?.body).toContain("Fixture body field prose");
    expect(candidate?.body).not.toContain("Fixture connector body");
  });

  it("refuses missing or unknown inputs before fetching", async () => {
    await activateFixtureConnector();
    let fetches = 0;
    const fetcher = async (): Promise<ConfinedFetchResult> => {
      fetches += 1;
      return fixtureFetch();
    };

    const missing = await runConnector(root.dir, "fixture", {}, { fetcher });
    const unknown = await runConnector(root.dir, "fixture", { id: "story-1", extra: "nope" }, { fetcher });

    expect(missing).toMatchObject({ kind: "refused" });
    expect(unknown).toMatchObject({ kind: "refused" });
    expect(fetches).toBe(0);
  });

  it("refuses non-string and oversized inputs before fetching", async () => {
    await activateFixtureConnector();
    let fetches = 0;
    const fetcher = async (): Promise<ConfinedFetchResult> => {
      fetches += 1;
      return fixtureFetch();
    };

    const nonString = await runConnector(
      root.dir, "fixture", { id: 42 } as unknown as Record<string, string>, { fetcher });
    const oversized = await runConnector(root.dir, "fixture", { id: "x".repeat(600) }, { fetcher });

    expect(nonString).toMatchObject({ kind: "refused" });
    expect(oversized).toMatchObject({ kind: "refused" });
    expect(fetches).toBe(0);
  });

  it("enforces the configured minimum request interval before fetching", async () => {
    await activateFixtureConnector("ops@example.com", 1000);
    let fetches = 0;
    const fetcher = async (): Promise<ConfinedFetchResult> => {
      fetches += 1;
      return fixtureFetch();
    };

    const first = await runConnector(root.dir, "fixture", { id: "story-1" }, {
      fetcher,
      now: () => new Date("2026-07-08T00:00:00.000Z"),
    });
    const second = await runConnector(root.dir, "fixture", { id: "story-2" }, {
      fetcher,
      now: () => new Date("2026-07-08T00:00:00.500Z"),
    });

    expect(first.kind).toBe("staged");
    expect(second).toMatchObject({ kind: "refused" });
    expect(fetches).toBe(1);
  });

  it("fails closed when connector rate state resolves through an escaping parent", async () => {
    await activateFixtureConnector("ops@example.com", 1000);
    const outside = path.join(root.dir, "..", "outside-connectors");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "fixture.last-fetch.json"), JSON.stringify({ atMs: 0 }), "utf8");
    await symlink(outside, path.join(root.dir, ".llmwiki", "connectors"));
    let fetches = 0;

    const result = await runConnector(root.dir, "fixture", { id: "story-1" }, {
      fetcher: async () => {
        fetches += 1;
        return fixtureFetch();
      },
      now: () => new Date("2026-07-08T00:00:02.000Z"),
    });

    expect(result).toMatchObject({ kind: "unavailable" });
    expect(fetches).toBe(0);
  });

  it("creates connector rate state through the confined atomic writer", async () => {
    await activateFixtureConnector("ops@example.com", 1000);

    const result = await runConnector(root.dir, "fixture", { id: "story-1" }, {
      fetcher: () => fixtureFetch(),
      now: () => new Date("2026-07-08T00:00:00.000Z"),
    });

    expect(result.kind).toBe("staged");
  });

  it("changed content supersedes under a fresh candidate id", async () => {
    await activateFixtureConnector();
    const first = await runFixtureConnector();
    const second = await runFixtureConnector(CONTENT_HASH_B);
    expect(first.kind).toBe("staged");
    expect(second.kind).toBe("superseded");
    expect(await onlyCandidateId()).not.toBe(stagedId(first));
  });

  it("dedupes on the durable body block when sidecar provenance is stripped", async () => {
    await activateFixtureConnector();
    const first = await runFixtureConnector();
    expect(first.kind).toBe("staged");
    const id = stagedId(first);
    const file = path.join(root.dir, ".llmwiki", "candidates", `${id}.json`);
    const raw = JSON.parse(await readFile(file, "utf8"));
    delete raw.connectorProvenance;
    await writeFile(file, JSON.stringify(raw, null, 2), "utf8");

    const second = await runFixtureConnector();

    expect(second).toMatchObject({ kind: "noop", candidateIds: [id] });
    expect(await onlyCandidateId()).toBe(id);
  });

  it("fails closed when a superseded candidate cannot be archived", async () => {
    await activateFixtureConnector();
    const first = await runFixtureConnector();
    expect(first.kind).toBe("staged");
    await writeFile(path.join(root.dir, ".llmwiki", "candidates", "archive"), "not a directory", "utf8");

    const second = await runFixtureConnector(CONTENT_HASH_B);

    expect(second).toMatchObject({ kind: "unavailable" });
    expect(await onlyCandidateId()).toBe(stagedId(first));
  });

  it("restores already-archived candidates when a later archive fails", async () => {
    await activateFixtureConnector();
    const first = await runFixtureConnector();
    expect(first.kind).toBe("staged");
    const id = stagedId(first);
    const dupId = await seedDuplicatePendingCandidate(id);
    // A directory at the duplicate's archive target defeats both rename and the copy fallback.
    await mkdir(path.join(root.dir, ".llmwiki", "candidates", "archive", `${dupId}.json`), { recursive: true });

    const second = await runFixtureConnector(CONTENT_HASH_B);

    expect(second).toMatchObject({ kind: "unavailable" });
    const ids = (await listCandidates(root.dir)).map((candidate) => candidate.id).sort();
    expect(ids).toEqual([id, dupId].sort());
  });

  it("restores archived candidates when staging the replacement fails", async () => {
    await activateFixtureConnector();
    const first = await runFixtureConnector();
    expect(first.kind).toBe("staged");
    const profileFile = path.join(root.dir, ".llmwiki", "profile.json");
    const profile = JSON.parse(await readFile(profileFile, "utf8"));
    profile.entities.articles.fields.headline.type = "integer";
    await writeFile(profileFile, JSON.stringify(profile), "utf8");

    await expect(runFixtureConnector(CONTENT_HASH_B)).rejects.toThrow();

    expect(await onlyCandidateId()).toBe(stagedId(first));
  });

  it("appends a connector-fetch event after staging", async () => {
    await activateFixtureConnector();
    await runFixtureConnector();
    const { events } = await readEvents(root.dir);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("connector-fetch");
    expect(events[0]?.payload).toMatchObject({
      connectorId: "fixture",
      finalUrl: "https://fixture.local/story-1",
      contentHash: CONTENT_HASH_A,
    });
  });

  it("does not mutate candidates while the review lock is held", async () => {
    await activateFixtureConnector();
    expect(await acquireLock(root.dir)).toBe(true);
    try {
      const result = await runConnector(root.dir, "fixture", { id: "story-1" }, { fetcher: () => fixtureFetch() });
      expect(result.kind).toBe("unavailable");
      expect(await listCandidates(root.dir)).toHaveLength(0);
    } finally {
      await releaseLock(root.dir);
    }
  });

  it("injects the polite User-Agent from connector config before fetch", async () => {
    await activateFixtureConnector("desk@example.com");
    let seen: ConnectorRequest | undefined;
    await runConnector(root.dir, "fixture", { id: "story-1" }, {
      fetcher: async (request) => {
        seen = request;
        return fixtureFetch();
      },
    });
    expect(seen?.headers?.["User-Agent"]).toMatch(/^llmwiki\/[^ ]+ \(mailto:desk@example\.com\)$/);
  });
});
