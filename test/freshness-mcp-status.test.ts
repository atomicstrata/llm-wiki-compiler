/**
 * Integration tests for freshness-derived wiki_status fields.
 *
 * Exercises the new `stalePages`, `orphanedPages` (computed-orphaned superset),
 * and `stateStatus` fields on `collectStatus`. Verifies that corrupt state
 * never produces a `.bak` side-effect (the read-only contract).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "fs";
import { rm } from "fs/promises";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { collectStatus } from "../src/mcp/status.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import {
  writeSourceState,
  writeSourceFile,
  sha256Hex,
  writeCorruptTestStateJson,
} from "./fixtures/state-json.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";
import { buildServer } from "./fixtures/mcp-test-env.js";

type ResourceMap = Record<string, { readCallback: (uri: URL) => Promise<{ contents: Array<{ text: string }> }> }>;

let root: string;

beforeEach(async () => {
  root = await makeTempRoot("freshness-mcp");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("wiki_status freshness", () => {
  it("reports stale pages from a changed source", async () => {
    // State records a.md with OLD hash owning "topic", but disk has NEW content.
    const oldHash = sha256Hex("OLD content");
    await writeSourceState(root, { "a.md": { hash: oldHash, concepts: ["topic"] } });
    await writeSourceFile(root, "a.md", "NEW content");
    await writePage(path.join(root, CONCEPTS_DIR), "topic", { title: "Topic" }, "Body.");

    const status = await collectStatus(root);

    expect(status.stalePages).toContain("topic");
    expect(status.stateStatus).toBe("ok");
  });

  it("reports orphaned pages when all owning sources are deleted", async () => {
    // State records a.md owning "topic", but a.md is NOT on disk.
    await writeSourceState(root, { "a.md": { hash: "xyz", concepts: ["topic"] } });
    await writePage(path.join(root, CONCEPTS_DIR), "topic", { title: "Topic" }, "Body.");

    const status = await collectStatus(root);

    expect(status.orphanedPages).toContain("topic");
  });

  it("flags corrupt state distinctly and writes no .bak", async () => {
    await writePage(path.join(root, CONCEPTS_DIR), "topic", { title: "Topic" }, "Body.");
    await writeCorruptTestStateJson(root);

    const status = await collectStatus(root);

    expect(status.stateStatus).toBe("corrupt");
    expect(existsSync(path.join(root, ".llmwiki/state.json.bak"))).toBe(false);
  });

  it("returns empty pendingChanges on corrupt state (no false 'new' entries)", async () => {
    await writePage(path.join(root, CONCEPTS_DIR), "topic", { title: "Topic" }, "Body.");
    await writeSourceFile(root, "a.md", "some content");
    await writeCorruptTestStateJson(root);

    const status = await collectStatus(root);

    expect(status.stateStatus).toBe("corrupt");
    expect(status.pendingChanges).toEqual([]);
  });
});

describe("llmwiki://state resource — no .bak side effect", () => {
  it("writes no .bak file when state.json is corrupt", async () => {
    await writeCorruptTestStateJson(root);

    const server = buildServer(root);
    const resources = (server as unknown as { _registeredResources: ResourceMap })._registeredResources;
    const result = await resources["llmwiki://state"].readCallback(new URL("llmwiki://state"));

    expect(existsSync(path.join(root, ".llmwiki/state.json.bak"))).toBe(false);
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed).toMatchObject({ version: 1, sources: expect.any(Object) });
  });
});
