/**
 * Counts actual FileHandle bytes, including a readFile replacement, to distinguish
 * frontmatter-only I/O from buffered body reads. Real files retain parser parity.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readResolutionFrontmatter } from "../src/citations/frontmatter-reader.js";
import { parseFrontmatterStatus } from "../src/utils/markdown.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "answer-reader-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

/** Instrument the real handle without mocking its actual file contents. */
function meter(handle: FileHandle, maxRead = Infinity) {
  let returned = 0;
  let shortReads = 0;
  const read = handle.read.bind(handle);
  const readFile = handle.readFile.bind(handle);
  vi.spyOn(handle, "read").mockImplementation((async (buffer: Buffer, offset: number, length: number, position: number) => {
    const result = await read(buffer, offset, Math.min(length, maxRead), position);
    returned += result.bytesRead;
    if (result.bytesRead > 0 && result.bytesRead < length) shortReads++;
    return result;
  }) as FileHandle["read"]);
  vi.spyOn(handle, "readFile").mockImplementation((async (...args: Parameters<FileHandle["readFile"]>) => {
    const result = await readFile(...args);
    returned += Buffer.byteLength(result);
    return result;
  }) as FileHandle["readFile"]);
  return { bytes: () => returned, shorts: () => shortReads };
}

/** Open one real fixture; the test owns and closes its handle. */
async function fixture(text: string | Buffer) {
  const file = path.join(root, "page.md");
  await writeFile(file, text);
  return open(file, "r");
}

it.each([
  ["---\naliases: [Alpha]\n---", "\nbody"], ["---\r\naliases: [Café, 東京]\r\n---", "\r\nbody"],
  ["---\naliases: [invalid\n---", "\nbody"], ["---\naliases: [Alpha]\n", ""],
  ["---\n---\naliases: [late]\n---", "body"], ["---\n\n---", "tail"], ["---\r\n\r\n---", ""],
  ["---\na: 1\n---", "suffix"], ["---\na: 1\n---", ""],
  ["---\naliases: [Alpha]\n" + "# padding\n".repeat(7500) + "---", "\nbody"],
])("matches production parsing and returned bytes for fixture %#", async (header, body) => {
  const handle = await fixture(header + body);
  const measured = meter(handle);
  try {
    expect(await readResolutionFrontmatter(handle)).toEqual(parseFrontmatterStatus(header + body).meta);
    expect(measured.bytes()).toBe(Buffer.byteLength(header));
  } finally { await handle.close(); }
});

it("reads no body bytes after a tiny complete header and leaves the handle open", async () => {
  const header = "---\naliases: [Alpha]\n---";
  const handle = await fixture(header + "\n" + "body".repeat(1024 * 1024));
  const measured = meter(handle);
  try {
    expect(await readResolutionFrontmatter(handle)).toEqual({ aliases: ["Alpha"] });
    expect(measured.bytes()).toBe(Buffer.byteLength(header));
    expect((await handle.stat()).isFile()).toBe(true);
  } finally { await handle.close(); }
});

it("continues short positive reads across UTF-8 until the closing fence", async () => {
  const header = "---\r\naliases: [Café, 東京]\r\n---";
  const handle = await fixture(header + "\r\nbody");
  const measured = meter(handle, 1);
  try {
    expect(await readResolutionFrontmatter(handle)).toEqual({ aliases: ["Café", "東京"] });
    expect(measured.shorts()).toBeGreaterThan(0);
    expect(measured.bytes()).toBe(Buffer.byteLength(header));
  } finally { await handle.close(); }
});

it.each([["body".repeat(1024), 1], ["--xbody", 3], ["---\rx", 5], ["", 0]])("stops when an opening fence is impossible: %#", async (text, bytes) => {
  const handle = await fixture(text as string);
  const measured = meter(handle);
  try {
    expect(await readResolutionFrontmatter(handle)).toEqual({});
    expect(measured.bytes()).toBe(bytes);
  } finally { await handle.close(); }
});

it("propagates genuine read faults without closing the caller handle", async () => {
  const handle = await fixture("---\naliases: [Alpha]\n---");
  vi.spyOn(handle, "read").mockRejectedValueOnce(Object.assign(new Error("read fault"), { code: "EIO" }));
  try {
    await expect(readResolutionFrontmatter(handle)).rejects.toMatchObject({ code: "EIO" });
    expect((await handle.stat()).isFile()).toBe(true);
  } finally { await handle.close(); }
});

it("does not mistake high-bit bytes for an ASCII opening fence", async () => {
  const handle = await fixture(Buffer.concat([Buffer.from([0xad, 0xad, 0xad, 0x0a]), Buffer.alloc(1000, 0x61)]));
  const measured = meter(handle);
  try {
    expect(await readResolutionFrontmatter(handle)).toEqual({});
    expect(measured.bytes()).toBe(1);
  } finally { await handle.close(); }
});
