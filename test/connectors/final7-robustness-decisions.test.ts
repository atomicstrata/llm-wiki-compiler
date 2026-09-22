/**
 * @file test/connectors/final7-robustness-decisions.test.ts
 * @description Preserve public first-stage candidate canonicalization and
 * resolve fallible staged-change clock metadata before persistence.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listCandidates, writeFreshCandidate } from "../../src/compiler/candidates.js";
import type { ConfinedFetchResult } from "../../src/connectors/confined-fetch.js";
import { runConnector } from "../../src/connectors/run.js";
import { stageEntityPage } from "../../src/trust/staging.js";
import { snapshotCandidateQueue } from "../fixtures/candidate-queue.js";
import { buildResearchLiteProject, RESEARCH_LITE_PROFILE } from "../fixtures/profile-fixtures.js";
import { validateProfile } from "../../src/profile/validate.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { activateFixtureConnector } from "./run-test-fixtures.js";

const root = useTempRoot();
const BODY = "---\ntitle: Linear Attention\n---\n\nBody.\n";

/** Return one deterministic successful fixture response. */
function fixtureFetch(): Promise<ConfinedFetchResult> {
  return Promise.resolve({
    kind: "ok", finalUrl: "https://fixture.local/story-1",
    bytes: Buffer.from("{}"), contentHash: "a".repeat(64),
  });
}

describe("Final7 robustness decisions", () => {
  afterEach(() => { delete process.env.LLMWIKI_CONNECTORS; });

  it("canonicalizes the first connector stage onto an existing same-target candidate", async () => {
    await activateFixtureConnector(root.dir);
    const manual = await writeFreshCandidate(root.dir, {
      title: "Manual", slug: "fixture-story-1", summary: "", sources: [],
      body: "manual body", targetEntityType: "articles",
    });
    const file = path.join(root.dir, ".llmwiki", "candidates", `${manual.id}.json`);
    const before = await readFile(file, "utf8");

    const result = await runConnector(root.dir, "fixture", { id: "story-1" }, {
      fetcher: fixtureFetch,
    });

    expect(result.kind).toBe("staged");
    if (result.kind !== "staged") throw new Error(`expected staged, got ${result.kind}`);
    expect(result.candidateIds[0]).toBe(manual.id);
    expect(await readFile(file, "utf8")).not.toBe(before);
    expect(await listCandidates(root.dir)).toHaveLength(1);
  });

  it("calls a throwing staged clock before candidate persistence", async () => {
    await buildResearchLiteProject(root.dir);
    const before = await snapshotCandidateQueue(root.dir);

    await expect(stageEntityPage(root.dir, {
      entityType: "papers", slug: "linear-attention", body: BODY,
      profile: validateProfile(RESEARCH_LITE_PROFILE).profile, existingStagedCount: 0,
      now: () => { throw new Error("clock failed"); },
    })).rejects.toThrow("clock failed");

    expect(await snapshotCandidateQueue(root.dir)).toEqual(before);
  });

  it("captures one successful staged timestamp for the returned DTO", async () => {
    await buildResearchLiteProject(root.dir);
    let calls = 0;
    const fixed = new Date("2026-07-17T01:02:03.000Z");

    const staged = await stageEntityPage(root.dir, {
      entityType: "papers", slug: "linear-attention", body: BODY,
      profile: validateProfile(RESEARCH_LITE_PROFILE).profile, existingStagedCount: 0,
      now: () => { calls += 1; return fixed; },
    });

    expect({ calls, createdAt: staged.createdAt }).toEqual({
      calls: 1, createdAt: fixed.toISOString(),
    });
  });
});
