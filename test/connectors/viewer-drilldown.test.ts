/**
 * Real offline Crossref import and approval through the generic viewer snapshot.
 * The network is a fixture; connector mapping, durable provenance, approval,
 * profile validation and HTTP page serialization are production code.
 */
import { afterEach, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { useTempRoot } from "../fixtures/temp-root.js";
import { getBuiltinTemplate } from "../../src/profile/templates/registry.js";
import { runConnector } from "../../src/connectors/run.js";
import { listCandidates } from "../../src/compiler/candidates.js";
import approve from "../../src/commands/review-approve.js";
import { sha256Text } from "../../src/connectors/hash.js";
import { PROFILE_FILE } from "../../src/utils/constants.js";
import { buildViewerSnapshot } from "../../src/viewer/snapshot.js";
import { startViewerServer } from "../../src/viewer/server.js";

const fixturePath = path.resolve("test/fixtures/crossref-work.json");
const ctx = useTempRoot([".llmwiki", "sources"]);
const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

/** Install the actual current template, not a hand-maintained profile duplicate. */
async function importPaper(): Promise<string> {
  const profile = getBuiltinTemplate("autosci")!.profile;
  await mkdir(path.dirname(path.join(ctx.dir, PROFILE_FILE)), { recursive: true });
  await writeFile(path.join(ctx.dir, PROFILE_FILE), JSON.stringify(profile));
  await writeFile(path.join(ctx.dir, ".llmwiki/config.json"), JSON.stringify({ connectors: { crossref: { contactEmail: "test@example.com", allowedHosts: ["api.crossref.org"] } } }));
  vi.stubEnv("LLMWIKI_CONNECTORS", "crossref");
  vi.stubEnv("LLMWIKI_PROVIDER", "anthropic");
  vi.stubEnv("VOYAGE_API_KEY", "");
  const bytes = await readFile(fixturePath);
  const result = await runConnector(ctx.dir, "crossref", { doi: "10.123/example" }, {
    fetcher: async () => ({ kind: "ok", finalUrl: "https://api.crossref.org/works/10.123%2Fexample", bytes, contentHash: sha256Text(bytes.toString("utf8")) }),
    now: () => new Date("2026-09-08T00:00:00.000Z"),
  });
  expect(result.kind).toBe("staged");
  const [candidate] = await listCandidates(ctx.dir);
  expect(candidate).toBeDefined();
  await approve(candidate.id, { draftContentHash: sha256Text(candidate.body) });
  expect(process.exitCode).not.toBe(1);
  return "crossref-10-123-example";
}

it("shows imported paper fields and metadata origin without pretending to store the publication", async () => {
  const slug = await importPaper();
  const snapshot = await buildViewerSnapshot(ctx.dir);
  const server = await startViewerServer(snapshot, { host: "127.0.0.1", port: 0 });
  servers.push(server);
  const response = await fetch(`http://127.0.0.1:${server.port}/api/page/papers/${slug}`);
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page.frontmatter).toMatchObject({ title: "Example Paper", stage: "imported", doi: "10.123/example" });
  expect(page.frontmatter.authors.length).toBeGreaterThan(0);
  expect(page.frontmatter.year).toEqual(expect.any(Number));
  expect(page.entityContext.connector).toMatchObject({ connectorId: "crossref", sourceUrl: "https://api.crossref.org/works/10.123%2Fexample", fetchedAt: "2026-09-08T00:00:00.000Z" });
  expect(page.entityContext.sources).toEqual([]);
  expect(page.entityContext.relations).toEqual([]);
});
