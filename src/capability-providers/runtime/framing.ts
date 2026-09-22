/**
 * @file src/capability-providers/runtime/framing.ts
 * @description Provider V2 wire transport: four-byte unsigned big-endian
 * length-prefixed UTF-8 JSON frames. The decoder rejects an over-cap declared
 * length before allocation, enforces per-direction frame and byte ceilings,
 * decodes strict UTF-8, and parses each body with duplicate-key rejection.
 * Grammar and sequencing live in protocol.ts; this layer only proves bytes.
 */
import {
  MAX_PROTOCOL_FRAME_BYTES, MAX_PROTOCOL_STREAM_BYTES_PER_DIRECTION,
  MAX_PROTOCOL_STREAM_FRAMES,
} from "../constants.js";
import { canonicalBytes } from "../../profile/templates/signing/canonical.js";
import { parseBoundedUniqueJson } from "../../profile/templates/signing/json.js";

const LENGTH_PREFIX_BYTES = 4;

/** Typed transport violation; the protocol layer maps it to provider-protocol-invalid. */
export class ProviderFramingError extends Error {
  constructor(message = "provider protocol frame is invalid") {
    super(message);
    this.name = "ProviderFramingError";
  }
}

/** One decoded frame body plus the exact wire bytes it consumed. */
export interface DecodedFrameV1 {
  readonly value: unknown;
  readonly wireByteLength: number;
}

/** Encode one value as a length-prefixed canonical JSON frame. */
export function encodeFrame(value: unknown): Buffer {
  const body = canonicalBytes(value);
  if (body.byteLength > MAX_PROTOCOL_FRAME_BYTES) {
    throw new ProviderFramingError("provider protocol frame exceeds the frame byte cap");
  }
  const prefix = Buffer.alloc(LENGTH_PREFIX_BYTES);
  prefix.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([prefix, body]);
}

/** One per-direction incremental frame decoder bound to the stream ceilings. */
export interface FrameDecoderV1 {
  /** Append bytes and return every frame that became complete, in order. */
  push(chunk: Buffer): DecodedFrameV1[];
  /** True when a partial frame remains; a closed stream with pending bytes is truncated. */
  hasPendingBytes(): boolean;
}

/** Create one per-direction incremental frame decoder bound to the stream ceilings. */
export function createFrameDecoder(): FrameDecoderV1 {
  return new FrameDecoder();
}

/** Stateful pull decoder for one stream direction; never buffers beyond one frame. */
class FrameDecoder implements FrameDecoderV1 {
  private residual: Buffer = Buffer.alloc(0);
  private streamBytes = 0;
  private frameCount = 0;

  /** Append bytes and return every frame that became complete, in order. */
  push(chunk: Buffer): DecodedFrameV1[] {
    this.residual = this.residual.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.residual, chunk]);
    const frames: DecodedFrameV1[] = [];
    for (let frame = this.takeFrame(); frame !== null; frame = this.takeFrame()) frames.push(frame);
    return frames;
  }

  /** True when a partial frame remains; a closed stream with pending bytes is truncated. */
  hasPendingBytes(): boolean {
    return this.residual.length > 0;
  }

  private takeFrame(): DecodedFrameV1 | null {
    if (this.residual.length < LENGTH_PREFIX_BYTES) return null;
    const declaredLength = this.residual.readUInt32BE(0);
    if (declaredLength === 0) throw new ProviderFramingError("provider protocol frame declared zero length");
    if (declaredLength > MAX_PROTOCOL_FRAME_BYTES) {
      throw new ProviderFramingError("provider protocol frame declared length exceeds the frame cap");
    }
    const wireByteLength = LENGTH_PREFIX_BYTES + declaredLength;
    if (this.residual.length < wireByteLength) return null;
    const body = this.residual.subarray(LENGTH_PREFIX_BYTES, wireByteLength);
    this.residual = this.residual.subarray(wireByteLength);
    this.account(wireByteLength);
    return Object.freeze({ value: decodeBody(body), wireByteLength });
  }

  private account(wireByteLength: number): void {
    this.streamBytes += wireByteLength;
    if (this.streamBytes > MAX_PROTOCOL_STREAM_BYTES_PER_DIRECTION) {
      throw new ProviderFramingError("provider protocol stream exceeds the per-direction byte cap");
    }
    this.frameCount += 1;
    if (this.frameCount > MAX_PROTOCOL_STREAM_FRAMES) {
      throw new ProviderFramingError("provider protocol stream exceeds the per-direction frame cap");
    }
  }
}

/** Decode strict UTF-8 and parse one bounded duplicate-key-rejecting JSON body. */
function decodeBody(body: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new ProviderFramingError("provider protocol frame is not valid UTF-8");
  }
  try {
    return parseBoundedUniqueJson(text, MAX_PROTOCOL_FRAME_BYTES);
  } catch {
    throw new ProviderFramingError("provider protocol frame body is not bounded unique JSON");
  }
}
