/**
 * @file src/portable/originals/frames.ts
 * @description The bounded frame format every `portable-originals/2` stream
 * uses on the wire: a 4-byte big-endian header length, a JSON header of at
 * most 4 KiB, then exactly `header.bytes` (at most 64 KiB) of payload.
 *
 * Frames let a stream end with a refusal at any point — raw octets could not —
 * and keep every buffer bounded on both sides. The decoder is incremental: it
 * copies each received byte at most once into ONE fixed buffer the size of the
 * largest legal frame, never concatenates a stream or a network chunk, rejects
 * an impossible length BEFORE anything is allocated for it, and accepts only
 * the closed frame arms, with a zero payload for every metadata and terminal frame.
 */

import { ORIGINALS_LIMITS, ORIGINALS_REFUSAL_CODES_V2, type FrameHeaderV2 } from "./contracts.js";

/** One frame: its header and, for a data frame, its payload. */
export interface Frame { header: FrameHeaderV2; payload?: Uint8Array }

const LENGTH_BYTES = 4;
/** The largest legal frame on the wire. */
const MAX_FRAME_BYTES = LENGTH_BYTES + ORIGINALS_LIMITS.maxHeaderBytes + ORIGINALS_LIMITS.maxChunkBytes;

/** A malformed or oversized frame. */
export class FrameError extends Error {}

/** Encode one frame. */
export function encodeFrame(frame: Frame): Uint8Array {
  const payload = frame.payload ?? new Uint8Array(0);
  const header = Buffer.from(JSON.stringify({ ...frame.header, bytes: payload.byteLength }), "utf8");
  if (header.byteLength > ORIGINALS_LIMITS.maxHeaderBytes || payload.byteLength > ORIGINALS_LIMITS.maxChunkBytes) {
    throw new FrameError("frame over its bound");
  }
  const out = Buffer.allocUnsafe(LENGTH_BYTES + header.byteLength + payload.byteLength);
  out.writeUInt32BE(header.byteLength, 0);
  header.copy(out, LENGTH_BYTES);
  out.set(payload, LENGTH_BYTES + header.byteLength);
  return out;
}

/** True for a whole number at least `min`. */
const isCount = (value: unknown, min = 0): boolean => Number.isSafeInteger(value) && (value as number) >= min;
const isText = (value: unknown): boolean => typeof value === "string";
const ROLES: ReadonlySet<unknown> = new Set(["page", "source", "reference", "original"]);
const CODES: ReadonlySet<unknown> = new Set(ORIGINALS_REFUSAL_CODES_V2);

/** True when `fence` is a completed frame's full fence. */
function isFence(fence: unknown): boolean {
  const value = fence as Record<string, unknown> | null;
  return value !== null && typeof value === "object" && isText(value.catalogRoot) && isText(value.labelEpoch) && isCount(value.policyRevision);
}

/** A frame arm's own check of its fields; every arm but `data` carries no payload. */
type ArmCheck = (header: Record<string, unknown>) => boolean;

/** The closed frame arms, each with the fields it must carry. */
const ARMS: Readonly<Record<string, ArmCheck>> = {
  data: (header) => isCount(header.bytes, 1) && (header.bytes as number) <= ORIGINALS_LIMITS.maxChunkBytes,
  object: (header) => ROLES.has(header.role) && isText(header.path) && isText(header.digest) && isCount(header.byteCount)
    && Array.isArray(header.labels) && header.labels.every(isText),
  range: (header) => isText(header.name) && isText(header.digest) && isCount(header.byteCount) && isCount(header.start) && isCount(header.end),
  completed: (header) => isCount(header.count) && isFence(header.fence),
  end: () => true,
  refused: (header) => CODES.has(header.code),
};

/** True when `header` is one of the closed frame arms, with the payload length its arm allows. */
function isClosedArm(header: Record<string, unknown>): boolean {
  const check = typeof header.kind === "string" && Object.hasOwn(ARMS, header.kind) ? ARMS[header.kind] : undefined;
  return check !== undefined && (header.kind === "data" || header.bytes === 0) && check(header);
}

/** The validated header of one frame's header bytes: only a closed arm is accepted. */
function headerOf(bytes: Uint8Array): FrameHeaderV2 {
  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new FrameError("malformed frame header");
  }
  if (header === null || typeof header !== "object" || !isClosedArm(header as Record<string, unknown>)) throw new FrameError("not a frame of this protocol");
  return header as FrameHeaderV2;
}

/** Incremental decoder of a frame stream, with one fixed buffer. */
export class FrameDecoder {
  private readonly buffer = new Uint8Array(MAX_FRAME_BYTES);
  private filled = 0;
  private headerBytes = -1;
  private header: FrameHeaderV2 | null = null;
  /** The most bytes ever held at once: bounded by {@link MAX_FRAME_BYTES}. */
  maxBuffered = 0;

  /** True when no partial frame is held. */
  get idle(): boolean {
    return this.filled === 0;
  }

  /** How many bytes the frame being decoded still needs before its next step. */
  private needed(): number {
    if (this.headerBytes < 0) return LENGTH_BYTES - this.filled;
    if (this.header === null) return LENGTH_BYTES + this.headerBytes - this.filled;
    return LENGTH_BYTES + this.headerBytes + this.header.bytes - this.filled;
  }

  /**
   * Feed one received chunk and yield each frame it completes, ONE AT A TIME:
   * the next frame is decoded only when the caller pulls it, so at most one
   * decoded payload copy is outstanding per pull, however many frames a
   * coalesced network chunk carries.
   */
  *push(chunk: Uint8Array): Generator<Frame> {
    let offset = 0;
    while (offset < chunk.byteLength || this.needed() === 0) {
      const take = Math.min(this.needed(), chunk.byteLength - offset);
      this.buffer.set(chunk.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      this.maxBuffered = Math.max(this.maxBuffered, this.filled);
      if (this.needed() > 0) return;
      const frame = this.step();
      if (frame !== null) yield frame;
    }
  }

  /** Advance one step once its bytes are present; a completed frame is returned and the buffer reset. */
  private step(): Frame | null {
    if (this.headerBytes < 0) {
      this.headerBytes = new DataView(this.buffer.buffer, 0, LENGTH_BYTES).getUint32(0);
      if (this.headerBytes < 2 || this.headerBytes > ORIGINALS_LIMITS.maxHeaderBytes) throw new FrameError("impossible frame header length");
      return null;
    }
    if (this.header === null) {
      this.header = headerOf(this.buffer.subarray(LENGTH_BYTES, LENGTH_BYTES + this.headerBytes));
      if (this.header.bytes > 0) return null;
    }
    const start = LENGTH_BYTES + this.headerBytes;
    const frame: Frame = { header: this.header, ...(this.header.bytes > 0 ? { payload: this.buffer.slice(start, start + this.header.bytes) } : {}) };
    this.filled = 0;
    this.headerBytes = -1;
    this.header = null;
    return frame;
  }
}
