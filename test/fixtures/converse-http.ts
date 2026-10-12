/**
 * Minimal AWS event-stream wire fixtures, independent of the provider transport.
 * Frames include the prelude and message CRCs so tests exercise SDK decoding of
 * the same binary protocol delivered by a Converse-compatible service.
 */
import { crc32 } from "node:zlib";

/** Encode one named JSON event using the AWS event-stream framing specification. */
export function converseEvent(eventType: string, payload: unknown): Buffer {
  const headerValues = { ":message-type": "event", ":event-type": eventType, ":content-type": "application/json" };
  const headers = Buffer.concat(Object.entries(headerValues).map(([key, value]) => {
    const name = Buffer.from(key);
    const text = Buffer.from(value);
    const size = Buffer.alloc(2);
    size.writeUInt16BE(text.length);
    return Buffer.concat([Buffer.from([name.length]), name, Buffer.from([7]), size, text]);
  }));
  const body = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(16 + headers.length + body.length);
  frame.writeUInt32BE(frame.length, 0);
  frame.writeUInt32BE(headers.length, 4);
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
  headers.copy(frame, 12);
  body.copy(frame, 12 + headers.length);
  frame.writeUInt32BE(crc32(frame.subarray(0, -4)), frame.length - 4);
  return frame;
}
