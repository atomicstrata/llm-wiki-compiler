/**
 * Metadata-only reading over a caller-owned handle from absolute offset zero.
 * The production parser accepts a closing fence immediately after its third
 * dash (no trailing newline required). Reads never cross that decisive byte.
 * Normal complete headers within 64 KiB therefore consume only header bytes.
 * Late/absent fences have NO fixed byte bound: they cost O(header/EOF bytes)
 * memory and small reads (at most four bytes each), even for malformed YAML.
 * These small reads avoid retained body bytes; they are not a speed optimization
 * and can cost more I/O calls than a full read, especially for late/missing fences.
 * Decode once after collecting bytes so UTF-8 split across reads stays intact.
 */
import type { FileHandle } from "node:fs/promises";
import { parseFrontmatterStatus } from "../utils/markdown.js";

const OPENINGS = ["---\n", "---\r\n"];
const CLOSING = Buffer.from("\n---");

/** Probe one byte at a time so an impossible opener stops immediately. */
async function readOpening(handle: FileHandle): Promise<Buffer | null> {
  const bytes: number[] = [];
  const byte = Buffer.alloc(1);
  while (true) {
    const { bytesRead } = await handle.read(byte, 0, 1, bytes.length);
    if (bytesRead === 0) return null;
    bytes.push(byte[0]);
    const prefix = Buffer.from(bytes).toString("latin1");
    if (OPENINGS.includes(prefix)) return Buffer.from(bytes);
    if (!OPENINGS.some((opening) => opening.startsWith(prefix))) return null;
  }
}

/** Read production-compatible resolution frontmatter without closing the handle. */
export async function readResolutionFrontmatter(handle: FileHandle): Promise<Record<string, unknown>> {
  const opening = await readOpening(handle);
  if (!opening) return {};
  const bytes = [...opening];
  const buffer = Buffer.alloc(CLOSING.length);
  let matched = 0;
  while (matched < CLOSING.length) {
    // The nearest possible closer is this many bytes away: no body pre-read.
    const length = CLOSING.length - matched;
    const { bytesRead } = await handle.read(buffer, 0, length, bytes.length);
    if (bytesRead === 0) break;
    for (const byte of buffer.subarray(0, bytesRead)) {
      bytes.push(byte);
      matched = byte === CLOSING[matched] ? matched + 1 : Number(byte === CLOSING[0]);
    }
  }
  return parseFrontmatterStatus(Buffer.from(bytes).toString("utf-8")).meta;
}
