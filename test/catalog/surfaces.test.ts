/**
 * @file test/catalog/surfaces.test.ts
 * @description More catalog surfaces on real disk: SDK limits are normalized
 * so no limit value can escape the page and examined-row bounds; a deep,
 * over-long source path is reported as uncatalogued without publishing an
 * unreadable catalog; `status` carries the catalog note; the MCP whole-list
 * resources keep their incumbent shapes beside a freshness note; and a profile install that waited for
 * the lock while the project became indexed is refused under the lock with
 * nothing written. In that race everything activation does but publishing the
 * active record runs BEFORE the lock is taken, and the record is published
 * only once the install is observed inside the real blocking acquisition, so
 * the race fits well inside the product's 5 s lock wait.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { registerWikiResources } from "../../src/mcp/resources.js";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import { routedListPages } from "../../src/catalog/routes.js";
import { installStarterProfile } from "../../src/profile/scaffold.js";
import { newCounters, observeIo } from "../../src/segments/counters.js";
import { collectStatus } from "../../src/status/collect.js";
import { acquireLock, releaseLock } from "../../src/utils/lock.js";
import { activateIndexed, prepareIndexedActivation, publishIndexedActivation, sourceText, writeCorpus } from "./helpers.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-catalog-surf-")); });
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("limit normalization", () => {
  it("bounds every page and its examined rows whatever limit the SDK is given", async () => {
    await writeCorpus(root, 1100, 0);
    await activateIndexed(root);
    for (const [limit, expected] of [[0.11, 1000], [1.1, 1], [Number.NaN, 1000], [Number.POSITIVE_INFINITY, 1000], [5000, 1000], [7, 7]] as const) {
      const counters = newCounters();
      const result = await observeIo(counters, () => routedListPages(root, { limit }));
      expect(result.pages).toHaveLength(expected);
      expect(counters.rowsReturned).toBe(expected);
      expect(result.cursor).toBeDefined();
    }
  });
});

describe("uncatalogued paths", () => {
  it("reports a deep over-long source path in a bounded sample and keeps the catalog readable", async () => {
    await writeCorpus(root, 0, 2);
    const deep = path.join(root, "sources", ...Array.from({ length: 6 }, (_, at) => `${"d".repeat(90)}${at}`));
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, "deep.md"), sourceText("Deep", "manual:deep"));
    await mkdir(path.join(root, ".llmwiki"), { recursive: true });
    await writeFile(path.join(root, ".llmwiki", "config.json"), JSON.stringify({ version: 1, sources: { recursive: true } }));
    await activateIndexed(root);
    const status = await collectStatus(root);
    expect(status.catalog).toMatchObject({ active: true, counts: { sources: 2 }, catalog: { uncatalogued: { count: 1 } } });
    expect(status.catalog!.catalog!.uncatalogued!.sample[0]!.length).toBeLessThanOrEqual(512);
  });
});

describe("MCP whole-list resources", () => {
  it("carry the catalog freshness note beside the complete arrays they still return", async () => {
    await writeCorpus(root, 3, 2);
    await activateIndexed(root);
    await writeFile(path.join(root, "wiki", "concepts", "zz.md"), "---\ntitle: Z\n---\n\nZ.\n");
    const server = new McpServer({ name: "llmwiki", version: "test" });
    registerWikiResources(server, root);
    const internals = server as unknown as {
      _registeredResources: Record<string, { readCallback: (uri: URL) => Promise<{ contents: Array<{ text: string }> }> }>;
      _registeredResourceTemplates: Record<string, { resourceTemplate: { listCallback: (extra: unknown) => Promise<{ resources: unknown[]; _meta?: unknown }> } }>;
    };
    const sources = await internals._registeredResources["llmwiki://sources"]!.readCallback(new URL("llmwiki://sources"));
    expect(JSON.parse(sources.contents[0]!.text)).toEqual(expect.arrayContaining([expect.objectContaining({ filename: "src-00000.md", title: "Source 0" })]));
    expect(JSON.parse(sources.contents[1]!.text)).toMatchObject({ state: "stale", staleDirectories: ["wiki/concepts"] });
    const concepts = await internals._registeredResourceTemplates["wiki-concept"]!.resourceTemplate.listCallback({});
    expect([concepts.resources.length, concepts._meta]).toEqual([3, { catalog: expect.objectContaining({ state: "stale" }) }]);
  });
});

/** Resolves once a caller enters the REAL blocking mutation-lock acquisition (a call-through spy). */
function lockWaitEntered(): Promise<void> {
  const real = lockGate.acquireMutationLockBlocking;
  return new Promise((resolve) => {
    vi.spyOn(lockGate, "acquireMutationLockBlocking").mockImplementation((...args) => { resolve(); return real(...args); });
  });
}

describe("a profile install racing indexed activation", () => {
  it("is refused under the lock it waited for, with nothing written", async () => {
    await writeCorpus(root, 2, 0);
    const pending = await prepareIndexedActivation(root);
    expect(await acquireLock(root)).toBe(true);
    const waiting = lockWaitEntered();
    const install = installStarterProfile(root, "custom", "paper").then(() => "installed", (error) => String(error.block ?? error));
    let before: string[] = [];
    try {
      const first = await Promise.race([waiting.then(() => "entered" as const), install.then(() => "settled" as const)]);
      expect(first).toBe("entered");
      await publishIndexedActivation(root, pending);
      before = (await readdir(path.join(root, ".llmwiki"))).sort();
    } finally {
      await releaseLock(root);
    }
    expect(await install).toBe("scale-profile-ineligible");
    expect((await readdir(path.join(root, ".llmwiki"))).sort()).toEqual(before.filter((name) => name !== "lock" && !/^lock\..+\.publishing$/.test(name)));
  });
});
