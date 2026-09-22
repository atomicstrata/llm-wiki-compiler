/**
 * @file test/connectors/run-test-fixtures.ts
 * @description Shared destructive fixture helpers for connector staging tests.
 * These helpers operate only inside each suite's temporary project root.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConfinedFetchResult } from "../../src/connectors/confined-fetch.js";
import { buildNewsroomProject } from "../fixtures/newsroom-profile.js";

/** Install and activate the deterministic fixture connector. */
export async function activateFixtureConnector(root: string): Promise<void> {
  await buildNewsroomProject(root);
  const config = { connectors: { fixture: {
    contactEmail: "ops@example.com",
    allowedHosts: ["fixture.local"],
  } } };
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(root, ".llmwiki", "config.json"), JSON.stringify(config));
  process.env.LLMWIKI_CONNECTORS = "fixture";
}

/** Make fixture connector staging fail after candidate archives have landed. */
export async function invalidateFixtureHeadlineType(root: string): Promise<void> {
  const profilePath = path.join(root, ".llmwiki", "profile.json");
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  profile.entities.articles.fields.headline.type = "integer";
  await writeFile(profilePath, JSON.stringify(profile), "utf8");
}

/** Return a deterministic fixture fetcher that records each invocation. */
export function countedFixtureFetch(counter: { value: number }) {
  return async (): Promise<ConfinedFetchResult> => {
    counter.value += 1;
    return {
      kind: "ok", finalUrl: "https://fixture.local/story-1",
      bytes: Buffer.from("{}"), contentHash: "d".repeat(64),
    };
  };
}
