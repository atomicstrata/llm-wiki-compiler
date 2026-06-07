/**
 * Tests for the session adapter pipeline:
 *   - Claude (.jsonl), Codex (.json array), Cursor (.json object) adapters
 *   - Auto-detection via the registry
 *   - Markdown formatting of normalised sessions
 *   - Error handling for malformed or unrecognised files
 *   - End-to-end write to sources/ via ingestSessionFile
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import { mkdir, readdir } from "fs/promises";
import { claudeAdapter } from "../src/adapters/claude.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { cursorAdapter } from "../src/adapters/cursor.js";
import { detectAdapter, parseSessionFile, formatSessionAsMarkdown, ADAPTERS } from "../src/adapters/registry.js";
import { ingestSessionFile } from "../src/commands/ingest-session.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures/sessions");
const claudeFile = path.join(FIXTURES, "claude-session.jsonl");
const codexFile = path.join(FIXTURES, "codex-session.json");
const cursorFile = path.join(FIXTURES, "cursor-session.json");
const malformedFile = path.join(FIXTURES, "malformed.jsonl");

// ---------------------------------------------------------------------------
// Claude adapter
// ---------------------------------------------------------------------------

describe("claudeAdapter", () => {
  it("detects a Claude .jsonl session file", async () => {
    expect(await claudeAdapter.detect(claudeFile)).toBe(true);
  });

  it("does not detect a Codex .json file as Claude", async () => {
    expect(await claudeAdapter.detect(codexFile)).toBe(false);
  });

  it("parses turns with correct roles", async () => {
    const session = await claudeAdapter.parse(claudeFile);
    const roles = session.turns.map((t) => t.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("derives title from first user message", async () => {
    const session = await claudeAdapter.parse(claudeFile);
    expect(session.title).toBe("How do I implement a binary search tree in TypeScript?");
  });

  it("records adapter name as 'claude'", async () => {
    const session = await claudeAdapter.parse(claudeFile);
    expect(session.adapter).toBe("claude");
  });

  it("captures startedAt and endedAt timestamps", async () => {
    const session = await claudeAdapter.parse(claudeFile);
    expect(session.startedAt).toBe("2024-01-15T10:00:00.000Z");
    expect(session.endedAt).toBe("2024-01-15T10:01:10.000Z");
  });

  it("throws a descriptive error on malformed JSON line", async () => {
    await expect(claudeAdapter.parse(malformedFile)).rejects.toThrow(/Malformed JSON on line/);
  });
});

// ---------------------------------------------------------------------------
// Codex adapter
// ---------------------------------------------------------------------------

describe("codexAdapter", () => {
  it("detects a Codex .json session file", async () => {
    expect(await codexAdapter.detect(codexFile)).toBe(true);
  });

  it("does not detect a Cursor .json file as Codex", async () => {
    expect(await codexAdapter.detect(cursorFile)).toBe(false);
  });

  it("parses title from conversation metadata", async () => {
    const session = await codexAdapter.parse(codexFile);
    expect(session.title).toBe("Explain async/await in JavaScript");
  });

  it("records adapter name as 'codex'", async () => {
    const session = await codexAdapter.parse(codexFile);
    expect(session.adapter).toBe("codex");
  });

  it("parses at least two turns", async () => {
    const session = await codexAdapter.parse(codexFile);
    expect(session.turns.length).toBeGreaterThanOrEqual(2);
  });

  it("captures create_time and update_time as ISO strings", async () => {
    const session = await codexAdapter.parse(codexFile);
    expect(session.startedAt).toBe("2024-01-15T10:00:00.000Z");
    expect(session.endedAt).toBe("2024-01-15T10:05:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Cursor adapter
// ---------------------------------------------------------------------------

describe("cursorAdapter", () => {
  it("detects a Cursor tabs export file", async () => {
    expect(await cursorAdapter.detect(cursorFile)).toBe(true);
  });

  it("does not detect a Codex file as Cursor", async () => {
    expect(await cursorAdapter.detect(codexFile)).toBe(false);
  });

  it("parses title from tab metadata", async () => {
    const session = await cursorAdapter.parse(cursorFile);
    expect(session.title).toBe("Refactor the authentication module");
  });

  it("records adapter name as 'cursor'", async () => {
    const session = await cursorAdapter.parse(cursorFile);
    expect(session.adapter).toBe("cursor");
  });

  it("captures timestamp range from messages", async () => {
    const session = await cursorAdapter.parse(cursorFile);
    expect(session.startedAt).toBe("2024-02-10T09:00:00.000Z");
    expect(session.endedAt).toBe("2024-02-10T09:01:15.000Z");
  });
});

// ---------------------------------------------------------------------------
// Registry: auto-detection
// ---------------------------------------------------------------------------

describe("detectAdapter", () => {
  it("routes a .jsonl file to the claude adapter", async () => {
    const adapter = await detectAdapter(claudeFile);
    expect(adapter?.name).toBe("claude");
  });

  it("routes a Codex JSON to the codex adapter", async () => {
    const adapter = await detectAdapter(codexFile);
    expect(adapter?.name).toBe("codex");
  });

  it("routes a Cursor JSON to the cursor adapter", async () => {
    const adapter = await detectAdapter(cursorFile);
    expect(adapter?.name).toBe("cursor");
  });

  it("returns null for an unrecognised file", async () => {
    const adapter = await detectAdapter(path.join(FIXTURES, "sample-source.md").replace("sessions/", "../"));
    expect(adapter).toBeNull();
  });

  it("parseSessionFile throws a descriptive error for unrecognised file", async () => {
    const unknown = path.join(FIXTURES, "../sample-source.md");
    await expect(parseSessionFile(unknown)).rejects.toThrow(/No session adapter/);
  });
});

// ---------------------------------------------------------------------------
// formatSessionAsMarkdown
// ---------------------------------------------------------------------------

describe("formatSessionAsMarkdown", () => {
  it("renders turns as markdown headings with role labels", async () => {
    const session = await claudeAdapter.parse(claudeFile);
    const md = formatSessionAsMarkdown(session);
    expect(md).toContain("### User");
    expect(md).toContain("### Claude Code");
    expect(md).toContain("binary search tree");
  });

  it("includes timestamps in headings when present", async () => {
    const session = await claudeAdapter.parse(claudeFile);
    const md = formatSessionAsMarkdown(session);
    expect(md).toContain("2024-01-15T10:00:00.000Z");
  });

  // Empty sessions are now rejected by parseSessionFile's usable-turns guard
  // (see registry.ts) before they ever reach the formatter, so the previous
  // "fallback message" branch was unreachable. The formatter now renders an
  // empty turns array as the empty string.
  it("renders empty turns array as empty string (unreachable in production)", () => {
    const md = formatSessionAsMarkdown({
      title: "Empty",
      adapter: "test",
      turns: [],
    });
    expect(md).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Registry: ADAPTERS list
// ---------------------------------------------------------------------------

describe("ADAPTERS", () => {
  it("contains exactly claude, codex, and cursor adapters", () => {
    const names = ADAPTERS.map((a) => a.name);
    expect(names).toContain("claude");
    expect(names).toContain("codex");
    expect(names).toContain("cursor");
    expect(names).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// ingestSessionFile: end-to-end write to sources/
// ---------------------------------------------------------------------------

describe("ingestSessionFile", () => {
  let tempRoot: string;
  let originalCwd: string;

  beforeEach(async () => {
    tempRoot = path.join(
      os.tmpdir(),
      `llmwiki-session-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(tempRoot, { recursive: true });
    originalCwd = process.cwd();
  });

  // Restore cwd after each test so a test that changes it cannot leak a stale
  // working directory into the rest of the suite, even when it throws.
  afterEach(() => process.chdir(originalCwd));

  it("saves a Claude session to sources/ and returns correct metadata", async () => {
    const result = await ingestSessionFile(tempRoot, claudeFile);
    expect(result.adapter).toBe("claude");
    expect(result.filename.endsWith(".md")).toBe(true);
    expect(result.title).toBe("How do I implement a binary search tree in TypeScript?");

    const files = await readdir(path.join(tempRoot, "sources"));
    expect(files).toContain(result.filename);
  });

  it("saves a Codex session to sources/ and returns correct metadata", async () => {
    const result = await ingestSessionFile(tempRoot, codexFile);
    expect(result.adapter).toBe("codex");
    expect(result.filename.endsWith(".md")).toBe(true);
  });

  it("saves a Cursor session to sources/ and returns correct metadata", async () => {
    const result = await ingestSessionFile(tempRoot, cursorFile);
    expect(result.adapter).toBe("cursor");
    expect(result.filename.endsWith(".md")).toBe(true);
  });
});
