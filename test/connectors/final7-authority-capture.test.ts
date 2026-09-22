/**
 * @file test/connectors/final7-authority-capture.test.ts
 * @description Decision 15 regressions for one frozen connector input,
 * definition, canonical-source, and candidate-identity authority snapshot.
 */

import { afterEach, describe, expect, it } from "vitest";
import { captureConnectorIdentity } from "../../src/connectors/candidate-identity.js";
import type { ConfinedFetchResult } from "../../src/connectors/confined-fetch.js";
import { getConnectorDef } from "../../src/connectors/registry.js";
import { runConnector } from "../../src/connectors/run.js";
import { listCandidates } from "../../src/compiler/candidates.js";
import { readEvents } from "../../src/events/store-read.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { activateFixtureConnector } from "./run-test-fixtures.js";

const root = useTempRoot();

/** Return one deterministic successful connector response. */
function fixtureFetch(): Promise<ConfinedFetchResult> {
  return Promise.resolve({
    kind: "ok",
    finalUrl: "https://fixture.local/story-1",
    bytes: Buffer.from("{}"),
    contentHash: "a".repeat(64),
  });
}

/** Build the identity-only definition used at the direct boundary. */
function identityDef(source: string) {
  return { id: "fixture", version: "1", canonicalSourceId: () => source };
}

describe("Final7 connector authority capture", () => {
  afterEach(() => { delete process.env.LLMWIKI_CONNECTORS; });

  it("rejects an accessor input without invoking it or fetching", async () => {
    await activateFixtureConnector(root.dir);
    let reads = 0;
    let fetches = 0;
    const inputs = Object.defineProperty({}, "id", {
      enumerable: true,
      get: () => { reads += 1; return "story-1"; },
    });

    const result = await runConnector(root.dir, "fixture", inputs as Record<string, string>, {
      fetcher: async () => { fetches += 1; return fixtureFetch(); },
    });

    expect(result).toMatchObject({ kind: "refused" });
    expect({ reads, fetches }).toEqual({ reads: 0, fetches: 0 });
  });

  it("rejects malformed UTF-16 input before fetch", async () => {
    await activateFixtureConnector(root.dir);
    let fetches = 0;

    const result = await runConnector(root.dir, "fixture", { id: "bad\ud800" }, {
      fetcher: async () => { fetches += 1; return fixtureFetch(); },
    });

    expect(result).toMatchObject({ kind: "refused" });
    expect(fetches).toBe(0);
  });

  it.each(["bad\ud800", "x".repeat(513), "😀".repeat(129)])(
    "rejects invalid canonical source %j before hashing",
    (source) => expect(captureConnectorIdentity(identityDef(source), {})).toBeNull(),
  );

  it("deep-freezes the admitted connector definition", () => {
    const def = getConnectorDef("fixture");

    expect(def).toBeDefined();
    expect(Object.isFrozen(def)).toBe(true);
    expect(Object.isFrozen(def?.allowedHosts)).toBe(true);
    expect(Object.isFrozen(def?.inputs)).toBe(true);
    expect(Object.isFrozen(def?.draftFields)).toBe(true);
  });

  it("captures connector metadata in one frozen identity", () => {
    const identity = captureConnectorIdentity(identityDef("source"), {});

    expect(identity).toMatchObject({
      connectorId: "fixture",
      connectorVersion: "1",
      canonicalSourceId: "source",
      slug: "fixture-source",
    });
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it("uses the captured identity for candidate provenance and audit", async () => {
    await activateFixtureConnector(root.dir);
    const identity = captureConnectorIdentity(identityDef("story-1"), {});

    await runConnector(root.dir, "fixture", { id: "story-1" }, { fetcher: fixtureFetch });
    const [candidate] = await listCandidates(root.dir);
    const event = (await readEvents(root.dir)).events.at(-1);
    const expected = {
      connectorId: identity?.connectorId,
      connectorVersion: identity?.connectorVersion,
    };

    expect(candidate?.connectorProvenance).toMatchObject(expected);
    expect(event?.payload).toMatchObject(expected);
  });
});
