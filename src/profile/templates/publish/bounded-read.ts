/**
 * @file src/profile/templates/publish/bounded-read.ts
 * @description Shared bounded handle reads and strict UTF-8 decoding for
 * untrusted publisher distribution and tap-key bytes.
 */
import type { FileHandle } from "node:fs/promises";
import { TextDecoder } from "node:util";

/** Read at most the configured bytes, rejecting concurrent growth past it. */
export async function readBoundedFromHandle(
  handle: FileHandle,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > maxBytes) throw new Error(`${label} exceeds its bounded size limit`);
  return buffer.subarray(0, total);
}

/** Decode protocol text without replacement-character recovery. */
export function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}
