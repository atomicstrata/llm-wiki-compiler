/**
 * Tests for the multimodal ingest pipeline (PDF, image, transcript).
 *
 * Covers:
 *   - source-type detection routes paths to the right ingest module
 *   - frontmatter records sourceType per type
 *   - happy paths for transcript parsers (.vtt, .srt, .txt)
 *   - tightened .txt transcript heuristic: requires repeated speaker + 2 distinct names
 *   - PDF title resolution (preserves Info.Title, falls back to filename)
 *   - image ingest surfaces a clear error when the active provider is non-vision
 *   - YouTube URL detection routes to the transcript handler
 *
 * Heavy lifting (real PDF parsing, real Anthropic vision calls, real YouTube
 * fetches) is intentionally avoided so tests stay deterministic and offline.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "fs/promises";
import path from "path";
import os from "os";
import { detectSourceType, buildDocument, enforceCharLimit } from "../src/commands/ingest.js";
import { parseFrontmatter } from "../src/utils/markdown.js";
import ingestTranscript, { isYoutubeUrl } from "../src/ingest/transcript.js";
import { resolveTitle } from "../src/ingest/pdf.js";
import ingestImage from "../src/ingest/image.js";

const tempDirsToCleanup: string[] = [];

async function makeTempFile(name: string, contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llmwiki-multimodal-"));
  tempDirsToCleanup.push(dir);
  const filePath = path.join(dir, name);
  await writeFile(filePath, contents, "utf-8");
  return filePath;
}

afterEach(async () => {
  while (tempDirsToCleanup.length > 0) {
    const dir = tempDirsToCleanup.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("detectSourceType", () => {
  it("routes .pdf paths to pdf", async () => {
    expect(await detectSourceType("/tmp/report.pdf")).toBe("pdf");
    expect(await detectSourceType("./docs/spec.PDF")).toBe("pdf");
  });

  it("routes image extensions to image", async () => {
    expect(await detectSourceType("/tmp/photo.png")).toBe("image");
    expect(await detectSourceType("/tmp/photo.jpg")).toBe("image");
    expect(await detectSourceType("/tmp/photo.JPEG")).toBe("image");
    expect(await detectSourceType("/tmp/anim.gif")).toBe("image");
    expect(await detectSourceType("/tmp/pic.webp")).toBe("image");
  });

  it("routes .vtt and .srt to transcript by extension (no content sniff)", async () => {
    expect(await detectSourceType("/tmp/lecture.vtt")).toBe("transcript");
    expect(await detectSourceType("/tmp/movie.srt")).toBe("transcript");
  });

  it("routes .txt with speaker tags to transcript via content sniff", async () => {
    // Alice appears twice (back-and-forth) and there are 2 distinct speakers.
    const filePath = await makeTempFile("chat.txt", "Alice: Hi.\nBob: Hello.\nAlice: How are you?");
    expect(await detectSourceType(filePath)).toBe("transcript");
  });

  it("routes .txt with single summary line to file (not transcript)", async () => {
    const filePath = await makeTempFile("note.txt", "Summary: this is an ordinary project note.");
    expect(await detectSourceType(filePath)).toBe("file");
  });

  it("routes .txt with multiple distinct section headers (no repeats) to file", async () => {
    const contents = "Summary: foo\nDetails: bar\nNotes: baz";
    const filePath = await makeTempFile("sections.txt", contents);
    expect(await detectSourceType(filePath)).toBe("file");
  });

  it("routes .txt where only one name repeats but there is only 1 distinct speaker to file", async () => {
    // Fails the distinct-speakers check (only "Summary" ever appears).
    const contents = "Summary: foo\nSummary: bar";
    const filePath = await makeTempFile("repeat-header.txt", contents);
    expect(await detectSourceType(filePath)).toBe("file");
  });

  it("routes .txt with repeated timestamps to transcript via content sniff", async () => {
    const filePath = await makeTempFile(
      "timed.txt",
      "00:01 Line one.\n00:02 Line two.\n00:03 Line three.\n",
    );
    expect(await detectSourceType(filePath)).toBe("transcript");
  });

  it("routes plain-prose .txt with no transcript signals to file", async () => {
    const filePath = await makeTempFile(
      "notes.txt",
      "This is a plain prose note with no speaker tags or timestamps.\n",
    );
    expect(await detectSourceType(filePath)).toBe("file");
  });

  it("routes .md to file", async () => {
    expect(await detectSourceType("/tmp/notes.md")).toBe("file");
  });

  it("routes generic http(s) URLs to web", async () => {
    expect(await detectSourceType("https://example.com/article")).toBe("web");
    expect(await detectSourceType("http://example.com/post")).toBe("web");
  });

  it("routes YouTube URLs to transcript", async () => {
    expect(await detectSourceType("https://www.youtube.com/watch?v=abc123")).toBe("transcript");
    expect(await detectSourceType("https://youtu.be/abc123")).toBe("transcript");
  });
});

describe("buildDocument frontmatter sourceType", () => {
  it("records sourceType in frontmatter for each type", () => {
    const result = enforceCharLimit("hello world");
    for (const type of ["web", "file", "image", "pdf", "transcript"] as const) {
      const doc = buildDocument("Title", "src", result, type);
      const { meta } = parseFrontmatter(doc);
      expect(meta.sourceType).toBe(type);
    }
  });

  it("omits sourceType when not provided (legacy callers preserved)", () => {
    const result = enforceCharLimit("hello world");
    const doc = buildDocument("Title", "src", result);
    const { meta } = parseFrontmatter(doc);
    expect(meta.sourceType).toBeUndefined();
    expect(meta.title).toBe("Title");
  });
});

describe("isYoutubeUrl", () => {
  it("matches youtube.com/watch URLs", () => {
    expect(isYoutubeUrl("https://www.youtube.com/watch?v=abc")).toBe(true);
    expect(isYoutubeUrl("https://youtube.com/watch?v=abc")).toBe(true);
  });

  it("matches youtu.be short URLs", () => {
    expect(isYoutubeUrl("https://youtu.be/abc123")).toBe(true);
  });

  it("rejects non-YouTube URLs", () => {
    expect(isYoutubeUrl("https://example.com/watch?v=abc")).toBe(false);
    expect(isYoutubeUrl("https://vimeo.com/abc")).toBe(false);
  });
});

describe("transcript ingest", () => {
  it("parses VTT preserving timestamps and cues", async () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "Alice: Welcome to the show.",
      "",
      "00:00:05.000 --> 00:00:08.000",
      "Bob: Thanks for having me.",
    ].join("\n");
    const filePath = await makeTempFile("ep.vtt", vtt);

    const result = await ingestTranscript(filePath);
    expect(result.title).toBe("ep");
    expect(result.content).toContain("00:00:01.000 --> 00:00:04.000");
    expect(result.content).toContain("Alice: Welcome to the show.");
    expect(result.content).toContain("Bob: Thanks for having me.");
  });

  it("parses SRT preserving timestamps and skipping sequence numbers", async () => {
    const srt = [
      "1",
      "00:00:01,000 --> 00:00:04,000",
      "Alice: Hello there.",
      "",
      "2",
      "00:00:05,000 --> 00:00:08,000",
      "Bob: General Kenobi.",
    ].join("\n");
    const filePath = await makeTempFile("clip.srt", srt);

    const result = await ingestTranscript(filePath);
    expect(result.title).toBe("clip");
    expect(result.content).toContain("00:00:01,000 --> 00:00:04,000");
    expect(result.content).toContain("Alice: Hello there.");
    expect(result.content).not.toMatch(/^1$/m);
  });

  it("parses plain .txt transcripts preserving speaker tags", async () => {
    const txt = "Alice: Hi.\nBob: Hello back.\n";
    const filePath = await makeTempFile("chat.txt", txt);

    const result = await ingestTranscript(filePath);
    expect(result.title).toBe("chat");
    expect(result.content).toContain("Alice: Hi.");
    expect(result.content).toContain("Bob: Hello back.");
  });

  it("rejects unsupported transcript extensions", async () => {
    const filePath = await makeTempFile("data.csv", "a,b,c");
    await expect(ingestTranscript(filePath)).rejects.toThrow(/Unsupported transcript file type/);
  });
});

describe("PDF ingest helpers", () => {
  it("resolveTitle prefers PDF Info.Title over filename", () => {
    const title = resolveTitle("/tmp/report.pdf", { Title: "Quarterly Report" });
    expect(title).toBe("Quarterly Report");
  });

  it("resolveTitle falls back to humanized filename when Info.Title is absent", () => {
    expect(resolveTitle("/tmp/quarterly_report.pdf", {})).toBe("quarterly report");
    expect(resolveTitle("/tmp/quarterly-report.pdf", undefined)).toBe("quarterly report");
  });

  it("resolveTitle ignores empty Info.Title", () => {
    const title = resolveTitle("/tmp/spec.pdf", { Title: "   " });
    expect(title).toBe("spec");
  });
});

describe("image ingest provider gating", () => {
  it("throws a clear error when the active provider is not Anthropic", async () => {
    const original = process.env.LLMWIKI_PROVIDER;
    process.env.LLMWIKI_PROVIDER = "ollama";
    try {
      await expect(ingestImage("/tmp/anything.png")).rejects.toThrow(
        /Image ingest requires the Anthropic provider/,
      );
    } finally {
      if (original === undefined) delete process.env.LLMWIKI_PROVIDER;
      else process.env.LLMWIKI_PROVIDER = original;
    }
  });
});
