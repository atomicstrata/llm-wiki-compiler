/** Selected nested sources must appear in status and stale-refresh guidance. */
import { beforeEach, expect, it } from "vitest";
import { writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { collectStatus } from "../src/status/collect.js";
import { resolveStaleRefresh } from "../src/compiler/refresh-plan.js";
import { collectStats } from "../src/eval/stats.js";
import { collectProjectState } from "../src/project/state.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { sha256Hex, writeSourceState } from "./fixtures/state-json.js";
import { connectMcpClient } from "./fixtures/mcp-test-env.js";
import { evaluateSourceUtilization } from "../src/eval/source-utilization.js";
import { writePage } from "./fixtures/write-page.js";

const root = useTempRoot(["sources/records", "sources/inbox", ".llmwiki"]);
beforeEach(async () => {
  await writeFile(path.join(root.dir, ".llmwiki/config.json"), JSON.stringify({
    version: 1, sources: { recursive: true, exclude: ["inbox", "draft.md"] },
  }));
  for (const id of ["records/note.md", "inbox/secret.md", "draft.md", "top.md"]) {
    await writeFile(path.join(root.dir, "sources", id), "body");
  }
  await writeSourceState(root.dir, {});
});

it("status reports selected nested new files without excluded files", async () => {
  const status = await collectStatus(root.dir);
  expect(status.pendingChanges).toEqual([
    { file: "records/note.md", status: "new" },
    { file: "top.md", status: "new" },
  ]);
});

it("status exposes pending retirement after exclusion and clears it on reselection", async () => {
  await writeSourceState(root.dir, {
    "records/note.md": { hash: sha256Hex("body"), concepts: [] },
    "top.md": { hash: sha256Hex("body"), concepts: [] },
  });
  expect((await collectStatus(root.dir)).pendingChanges).toEqual([]);
  const configPath = path.join(root.dir, ".llmwiki/config.json");
  for (const excludeRecords of [true, false]) {
    await writeFile(configPath, JSON.stringify({ version: 1, sources: {
      recursive: true, exclude: ["inbox", "draft.md", ...(excludeRecords ? ["records"] : [])],
    } }));
    const status = await collectStatus(root.dir);
    expect(status.pendingChanges).toEqual(excludeRecords
      ? [{ file: "records/note.md", status: "deleted" }] : []);
    expect(status.pendingChangesCount).toBe(excludeRecords ? 1 : 0);
  }
});

it("stale-refresh identifies selected nested files that need a full compile", async () => {
  const { plan } = await resolveStaleRefresh(root.dir);
  expect(plan?.newSkipped).toEqual(["records/note.md", "top.md"]);
});

it.each([
  { label: "eval", collect: collectStats },
  { label: "next-action", collect: collectProjectState },
])("$label counts selected nested sources rather than top-level entries", async ({ collect }) => {
  await writeFile(path.join(root.dir, "sources/records/second.md"), "another source");
  expect((await collect(root.dir)).sourceCount).toBe(3);
});

it("MCP source resources expose selected relative filenames over stdio", async () => {
  const { client, transport } = await connectMcpClient(root.dir);
  try {
    const result = await client.readResource({ uri: "llmwiki://sources" });
    const content = result.contents[0];
    if (!("text" in content)) throw new Error("Expected a JSON source resource");
    const records = JSON.parse(content.text) as Array<{ filename: string }>;
    expect(records.map((entry) => entry.filename)).toEqual(["records/note.md", "top.md"]);
  } finally {
    await client.close();
    await transport.close();
  }
});

it("utilization measures selected nested citations and explains skipped aliases", async () => {
  await symlink(path.join(root.dir, "sources/top.md"), path.join(root.dir, "sources/records/alias.md"));
  await writePage(path.join(root.dir, "wiki/concepts"), "topic", { title: "Topic" },
    "Nested evidence.^[records/note.md:1-1]");
  const result = await evaluateSourceUtilization(root.dir);
  expect(result.totalSources).toBe(2);
  expect(result.citedSources).toBe(1);
  expect(result.perSource).toEqual([
    { sourceFile: "records/note.md", citingPageCount: 1, citingPages: ["concepts/topic"] },
    { sourceFile: "top.md", citingPageCount: 0, citingPages: [] },
  ]);
  expect(result.warnings.some((warning) => warning.includes("records/alias.md"))).toBe(true);
});
