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

  it("reports uncompiled sources as pending on missing state (never-compiled project)", async () => {
    // No state.json written → state is "missing". Sources on disk should appear as "new".
    await writeSourceFile(root, "a.md", "first source");

    const status = await collectStatus(root);

    expect(status.stateStatus).toBe("missing");
    expect(status.pendingChanges).toContainEqual({ file: "a.md", status: "new" });
  });

  it("snapshot-derived pendingChanges: changed, new, and deleted sources all appear correctly", async () => {
    // a.md: recorded with OLD hash → changed
    const oldHash = sha256Hex("OLD content");
    // b.md: in state but not on disk → deleted
    const bHash = sha256Hex("b content");
    await writeSourceState(root, {
      "a.md": { hash: oldHash, concepts: [] },
      "b.md": { hash: bHash, concepts: [] },
    });
    // Write a.md with new content so its hash drifts.
    await writeSourceFile(root, "a.md", "NEW content");
    // Write c.md on disk but NOT in state → new.
    await writeSourceFile(root, "c.md", "c content");

    const status = await collectStatus(root);

    expect(status.stateStatus).toBe("ok");
    expect(status.pendingChanges).toEqual(
      expect.arrayContaining([
        { file: "a.md", status: "changed" },
        { file: "b.md", status: "deleted" },
        { file: "c.md", status: "new" },
      ]),
    );
    // unchanged entries must NOT appear
    expect(status.pendingChanges.some((c) => c.status === "unchanged")).toBe(false);
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
