/**
 * Tests for the `llmwiki status` command wrapper.
 *
 * The heavy lifting (freshness, page scan, candidates) is collectStatus's and
 * is covered by collect.test.ts. These tests pin the CLI contract: readable
 * human summary by default, a pure machine-readable JSON envelope with --json
 * (immune to verbose/status pollution), exit code 0 on successful inspection,
 * and no provider credentials required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import statusCommand from "../../src/commands/status.js";
import { setVerbose } from "../../src/utils/output.js";

/** Seed a minimal compiled project: one source, one concept page, valid state. */
async function seedProject(root: string): Promise<void> {
  await mkdir(path.join(root, "sources"), { recursive: true });
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  const sourceContent = "# Topic\n\nAbout the topic.";
  await writeFile(path.join(root, "sources", "a.md"), sourceContent, "utf-8");
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(sourceContent).digest("hex");
  await writeFile(
    path.join(root, ".llmwiki", "state.json"),
    JSON.stringify({
      version: 1,
      indexHash: "",
      sources: { "a.md": { hash, concepts: ["topic"], compiledAt: "2026-07-14T00:00:00.000Z" } },
    }),
    "utf-8",
  );
  await writeFile(
    path.join(root, "wiki", "concepts", "topic.md"),
    "---\ntitle: Topic\nsummary: The topic.\nsources: [a.md]\n---\n\nBody.\n",
    "utf-8",
  );
}

describe("statusCommand", () => {
  let root = "";
  let savedCwd = "";
  let logLines: string[];
  let stdoutChunks: string[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "llmwiki-status-cmd-"));
    savedCwd = process.cwd();
    process.chdir(root);
    logLines = [];
    stdoutChunks = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    });
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(async () => {
    process.chdir(savedCwd);
    vi.restoreAllMocks();
    setVerbose(false);
    await rm(root, { recursive: true, force: true });
  });

  it("prints a human summary with page/source counts and state status", async () => {
    await seedProject(root);

    const code = await statusCommand();

    expect(code).toBe(0);
    const out = logLines.join("\n");
    expect(out).toContain("1 concept");
    expect(out).toContain("Sources: 1");
    expect(out).toMatch(/State: ok/);
  });

  it("reports missing state on an uncompiled project without failing", async () => {
    const code = await statusCommand();

    expect(code).toBe(0);
    expect(logLines.join("\n")).toMatch(/State: missing/);
  });

  it("--json emits the collectStatus envelope as parseable JSON on stdout", async () => {
    await seedProject(root);

    const code = await statusCommand({ json: true });

    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutChunks.join(""));
    expect(parsed.pages.concepts).toBe(1);
    expect(parsed.sources).toBe(1);
    expect(parsed.stateStatus).toBe("ok");
    expect(parsed.staleCount).toBe(0);
    expect(Array.isArray(parsed.pendingChanges)).toBe(true);
  });

  it("--json stays pure when verbose mode is enabled", async () => {
    await seedProject(root);
    setVerbose(true);

    await statusCommand({ json: true });

    expect(() => JSON.parse(stdoutChunks.join(""))).not.toThrow();
    // Quiet mode must suppress all human/verbose lines in JSON mode.
    expect(logLines).toHaveLength(0);
  });
});
