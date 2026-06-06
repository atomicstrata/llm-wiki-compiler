/**
 * Tests for the append-only activity log (log.md).
 * Covers the parseable heading format, the optional bullet body (page links,
 * counts), single-line sanitization, append-only accumulation, wikilink-list
 * truncation, and the resilience guarantee that logging never throws.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  appendLog,
  formatLogEntry,
  formatList,
  formatWikilinkList,
} from "../src/utils/activity-log.js";
import {
  LOG_FILE,
  LOG_DESCRIPTION_MAX_CHARS,
  LOG_MAX_PAGE_LINKS,
} from "../src/utils/constants.js";

const DAY = new Date("2026-04-02T13:00:00Z");
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "activity-log-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("formatLogEntry", () => {
  it("renders the gist's parseable heading with the date's YYYY-MM-DD", () => {
    const entry = formatLogEntry("ingest", "Attention Is All You Need", DAY);
    expect(entry).toBe("## [2026-04-02T13:00:00Z] ingest | Attention Is All You Need");
  });

  it("collapses newlines so the heading stays a single grep-able line", () => {
    const entry = formatLogEntry("query", "What is\nself-attention?", DAY);
    expect(entry).toBe("## [2026-04-02T13:00:00Z] query | What is self-attention?");
  });

  it("appends detail lines as a markdown bullet body under the heading", () => {
    const entry = formatLogEntry("compile", "1 source → 2 pages", DAY, [
      "Pages: [[a]], [[b]]",
      "Deleted sources: 1",
    ]);
    expect(entry).toBe(
      "## [2026-04-02T13:00:00Z] compile | 1 source → 2 pages\n- Pages: [[a]], [[b]]\n- Deleted sources: 1",
    );
  });

  it("truncates over-long descriptions with an ellipsis", () => {
    const long = "x".repeat(LOG_DESCRIPTION_MAX_CHARS + 50);
    const description = formatLogEntry("query", long, DAY).split(" | ")[1];
    expect(description).toHaveLength(LOG_DESCRIPTION_MAX_CHARS);
    expect(description.endsWith("…")).toBe(true);
  });
});

describe("formatList", () => {
  it("joins items and returns empty string for an empty list", () => {
    expect(formatList(["a.md", "b.md"])).toBe("a.md, b.md");
    expect(formatList([])).toBe("");
  });

  it("truncates past the cap with a (+N more) suffix", () => {
    expect(formatList(["a", "b", "c"], 2)).toBe("a, b, … (+1 more)");
  });
});

describe("formatWikilinkList", () => {
  it("renders slugs as comma-separated wikilinks", () => {
    expect(formatWikilinkList(["self-attention", "transformer"])).toBe(
      "[[self-attention]], [[transformer]]",
    );
  });

  it("truncates past the cap with a (+N more) suffix", () => {
    const slugs = Array.from({ length: LOG_MAX_PAGE_LINKS + 3 }, (_, i) => `p${i}`);
    const rendered = formatWikilinkList(slugs);
    expect(rendered).toContain("… (+3 more)");
    expect(rendered.match(/\[\[/g)).toHaveLength(LOG_MAX_PAGE_LINKS);
  });
});

describe("appendLog", () => {
  it("creates log.md and appends entries in order, blank-line separated", async () => {
    await appendLog(tmpDir, "ingest", "First Article", { date: DAY });
    await appendLog(tmpDir, "compile", "1 source(s) → 2 page(s)", { date: DAY });

    const content = await readFile(path.join(tmpDir, LOG_FILE), "utf-8");
    expect(content).toBe(
      "## [2026-04-02T13:00:00Z] ingest | First Article\n\n" +
        "## [2026-04-02T13:00:00Z] compile | 1 source(s) → 2 page(s)\n\n",
    );
  });

  it("writes the bullet body when details are supplied", async () => {
    await appendLog(tmpDir, "compile", "1 source → 2 pages", {
      date: DAY,
      details: ["Pages: [[a]], [[b]]"],
    });

    const content = await readFile(path.join(tmpDir, LOG_FILE), "utf-8");
    expect(content).toBe("## [2026-04-02T13:00:00Z] compile | 1 source → 2 pages\n- Pages: [[a]], [[b]]\n\n");
  });

  it("keeps headings parseable by the gist's grep recipe despite bodies", async () => {
    await appendLog(tmpDir, "compile", "1 source(s) → 1 page(s)", {
      date: DAY,
      details: ["Created: [[some-page]]"],
    });

    const content = await readFile(path.join(tmpDir, LOG_FILE), "utf-8");
    const headings = content.split("\n").filter((line) => line.startsWith("## ["));
    expect(headings).toHaveLength(1);
  });

  it("never throws when the log cannot be written", async () => {
    const unwritable = path.join(tmpDir, "does", "not", "exist");
    await expect(appendLog(unwritable, "ingest", "Title")).resolves.toBeUndefined();
  });
});
