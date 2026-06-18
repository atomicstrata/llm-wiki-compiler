/**
 * @file test/wiki-collect-metadata-only.test.ts
 * @description Tests for the bounded frontmatter-only read path of
 * `scanEntityDir({ includeBody: false })`.
 *
 * The metadata-only path must (a) produce `frontmatter`/`parseStatus`
 * BYTE-IDENTICAL to a full body-reading scan across representative files (with
 * frontmatter, without, malformed YAML, CRLF, body larger than the cap), so
 * counts/problems are unchanged whether bodies are read or not; and (b) actually
 * avoid reading the whole file — a multi-MB body is summarized by reading only a
 * bounded prefix, never its full size.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { scanEntityDir } from "../src/wiki/collect.js";

/**
 * Spy that wraps `fs/promises.open` and tallies the bytes returned by each
 * `FileHandle.read`, so a test can assert the metadata-only path reads only a
 * bounded prefix rather than a multi-MB file's full size. Installed via
 * `vi.mock` because ESM named exports cannot be re-spied in place.
 */
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const originalRead = handle.read.bind(handle);
      handle.read = (async (...readArgs: unknown[]) => {
        const result = await (originalRead as (...a: unknown[]) => Promise<{ bytesRead: number }>)(...readArgs);
        bytesReadViaOpen += result.bytesRead;
        return result;
      }) as typeof handle.read;
      return handle;
    },
  };
});

let bytesReadViaOpen = 0;

let root = "";
const DIR = "wiki/notes";

/** Write a raw `.md` file (no transformation) under the notes directory. */
async function writeRaw(name: string, content: string): Promise<void> {
  await writeFile(path.join(root, DIR, name), content);
}

/** Scan the notes dir with bodies on/off and return scans sorted by stem. */
async function scanBoth() {
  const full = await scanEntityDir(root, DIR, { includeBody: true });
  const meta = await scanEntityDir(root, DIR, { includeBody: false });
  const sort = (a: { stem: string }, b: { stem: string }) => a.stem.localeCompare(b.stem);
  return { full: [...full.scans].sort(sort), meta: [...meta.scans].sort(sort) };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "wiki-meta-only-"));
  await mkdir(path.join(root, DIR), { recursive: true });
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("scanEntityDir metadata-only — meta/parseStatus identical to full read", () => {
  beforeEach(async () => {
    await writeRaw("with-fm.md", "---\ntitle: Hello\nstatus: open\n---\n# Body\n\nProse here.\n");
    await writeRaw("no-fm.md", "# Just a body\n\nNo frontmatter at all.\n");
    await writeRaw("malformed.md", "---\ntitle: [unclosed\n---\nbody\n");
    await writeRaw("crlf.md", "---\r\ntitle: CRLF\r\n---\r\nbody line\r\n");
    await writeRaw("big-body.md", `---\ntitle: Big\n---\n${"x".repeat(200 * 1024)}\n`);
  });

  it("produces identical frontmatter and parseStatus for every representative file", async () => {
    const { full, meta } = await scanBoth();
    expect(meta.map((s) => s.stem)).toEqual(full.map((s) => s.stem));
    for (let i = 0; i < full.length; i += 1) {
      expect(meta[i].frontmatter).toEqual(full[i].frontmatter);
      expect(meta[i].parseStatus).toEqual(full[i].parseStatus);
    }
  });

  it("drops the body on the metadata-only path while the full path keeps it", async () => {
    const { full, meta } = await scanBoth();
    expect(meta.every((s) => s.body === "")).toBe(true);
    expect(full.find((s) => s.stem === "with-fm")?.body).toContain("Prose here.");
  });
});

describe("scanEntityDir metadata-only — bounded prefix avoids full-body I/O", () => {
  it("reads far fewer than a multi-MB file's full size when summarizing", async () => {
    const bodyBytes = 4 * 1024 * 1024;
    await writeRaw("huge.md", `---\ntitle: Huge\n---\n${"y".repeat(bodyBytes)}\n`);
    bytesReadViaOpen = 0;
    const { scans } = await scanEntityDir(root, DIR, { includeBody: false });
    expect(scans).toHaveLength(1);
    expect(scans[0].body).toBe("");
    expect(scans[0].frontmatter).toEqual({ title: "Huge" });
    // The bounded prefix (<= 64 KiB) is a tiny fraction of the 4 MiB file.
    expect(bytesReadViaOpen).toBeLessThanOrEqual(64 * 1024);
    expect(bytesReadViaOpen).toBeLessThan(bodyBytes);
  });

  it("falls back to a full read when frontmatter closes beyond the prefix cap", async () => {
    const padding = "  - item\n".repeat(20 * 1024); // pushes the closing fence past 64 KiB
    await writeRaw("late-fence.md", `---\ntitle: Late\nitems:\n${padding}---\nbody\n`);
    const full = await scanEntityDir(root, DIR, { includeBody: true });
    const meta = await scanEntityDir(root, DIR, { includeBody: false });
    expect(meta.scans[0].frontmatter).toEqual(full.scans[0].frontmatter);
    expect(meta.scans[0].parseStatus).toEqual(full.scans[0].parseStatus);
    expect(meta.scans[0].frontmatter.title).toBe("Late");
  });

  it("summarizes a large NO-leading-frontmatter file reading only the bounded prefix", async () => {
    const bodyBytes = 2 * 1024 * 1024;
    await writeRaw("no-leading-fm.md", `# Heading\n\n${"z".repeat(bodyBytes)}\n`);
    bytesReadViaOpen = 0;
    const full = await scanEntityDir(root, DIR, { includeBody: true });
    const meta = await scanEntityDir(root, DIR, { includeBody: false });
    // Decisive: a file not opening with a fence never triggers the full read.
    expect(bytesReadViaOpen).toBeLessThanOrEqual(64 * 1024);
    expect(bytesReadViaOpen).toBeLessThan(bodyBytes);
    expect(meta.scans[0].frontmatter).toEqual(full.scans[0].frontmatter);
    expect(meta.scans[0].parseStatus).toEqual(full.scans[0].parseStatus);
    expect(meta.scans[0].parseStatus.hasFrontmatterBlock).toBe(false);
  });
});
