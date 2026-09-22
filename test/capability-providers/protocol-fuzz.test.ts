/**
 * @file test/capability-providers/protocol-fuzz.test.ts
 * @description Frame-transport fuzzing for the Provider V2 wire protocol. Every
 * malformed length prefix, oversized frame, truncation, invalid UTF-8, and
 * duplicate-key body must be refused with a typed framing violation before the
 * bytes can reach the message grammar.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_PROTOCOL_FRAME_BYTES, MAX_PROTOCOL_STREAM_FRAMES,
} from "../../src/capability-providers/constants.js";
import {
  createFrameDecoder, encodeFrame, ProviderFramingError,
} from "../../src/capability-providers/runtime/framing.js";
import {
  parseProviderFrame, ProviderProtocolError,
} from "../../src/capability-providers/runtime/protocol-parse.js";
import { PROVIDER_PROTOCOL_VERSION_V1 } from "../../src/capability-providers/runtime/types.js";

/** Assemble a wire frame with an explicit declared length for fuzzing. */
function framedBytes(declaredLength: number, body: Buffer): Buffer {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(declaredLength, 0);
  return Buffer.concat([prefix, body]);
}

/** Encode one canonical JSON body without its length prefix. */
function jsonBody(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

describe("provider wire framing", () => {
  it("round-trips one canonical JSON frame", () => {
    const frame = encodeFrame({ b: 2, a: 1 });
    const decoder = createFrameDecoder();
    const decoded = decoder.push(frame);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].value).toEqual({ a: 1, b: 2 });
    expect(decoder.hasPendingBytes()).toBe(false);
  });

  it("reassembles a frame delivered across multiple chunks", () => {
    const frame = encodeFrame({ message: "split" });
    const decoder = createFrameDecoder();
    expect(decoder.push(frame.subarray(0, 3))).toHaveLength(0);
    expect(decoder.push(frame.subarray(3, 6))).toHaveLength(0);
    const rest = decoder.push(frame.subarray(6));
    expect(rest).toHaveLength(1);
    expect(rest[0].value).toEqual({ message: "split" });
  });

  it("decodes several frames from one chunk in order", () => {
    const decoder = createFrameDecoder();
    const chunk = Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 })]);
    const decoded = decoder.push(chunk);
    expect(decoded.map((frame) => frame.value)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("refuses a zero-length declared frame", () => {
    const decoder = createFrameDecoder();
    expect(() => decoder.push(framedBytes(0, Buffer.alloc(0)))).toThrow(ProviderFramingError);
  });

  it("refuses a declared length over the frame cap before allocating", () => {
    const decoder = createFrameDecoder();
    const oversized = framedBytes(MAX_PROTOCOL_FRAME_BYTES + 1, Buffer.alloc(0));
    expect(() => decoder.push(oversized)).toThrow(ProviderFramingError);
  });

  it("refuses to encode a body larger than the frame cap", () => {
    const huge = { blob: "x".repeat(MAX_PROTOCOL_FRAME_BYTES + 1) };
    expect(() => encodeFrame(huge)).toThrow(ProviderFramingError);
  });

  it("reports pending bytes for a truncated final frame", () => {
    const decoder = createFrameDecoder();
    const frame = encodeFrame({ truncated: true });
    expect(decoder.push(frame.subarray(0, frame.length - 2))).toHaveLength(0);
    expect(decoder.hasPendingBytes()).toBe(true);
  });

  it("refuses invalid UTF-8 frame bytes", () => {
    const decoder = createFrameDecoder();
    const invalid = Buffer.from([0xff, 0xfe, 0xfd]);
    expect(() => decoder.push(framedBytes(invalid.length, invalid))).toThrow(ProviderFramingError);
  });

  it("refuses a body with duplicate JSON keys", () => {
    const decoder = createFrameDecoder();
    const duplicate = Buffer.from('{"a":1,"a":2}', "utf8");
    expect(() => decoder.push(framedBytes(duplicate.length, duplicate))).toThrow(ProviderFramingError);
  });

  it("refuses a non-JSON body", () => {
    const decoder = createFrameDecoder();
    const garbage = Buffer.from("not json", "utf8");
    expect(() => decoder.push(framedBytes(garbage.length, garbage))).toThrow(ProviderFramingError);
  });

  it("refuses more frames than the per-direction stream ceiling", () => {
    const decoder = createFrameDecoder();
    const frame = encodeFrame({ n: 0 });
    expect(() => {
      for (let index = 0; index <= MAX_PROTOCOL_STREAM_FRAMES; index += 1) decoder.push(frame);
    }).toThrow(ProviderFramingError);
  });
});

/** Build one syntactically well-framed provider->host message record. */
function providerMessage(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: PROVIDER_PROTOCOL_VERSION_V1, invocationId: "invocation-alpha",
    requestId: "provider-0", sequence: 0, type, ...extra,
  };
}

describe("provider message grammar fuzzing", () => {
  it("refuses an unknown message type", () => {
    expect(() => parseProviderFrame(providerMessage("promote"))).toThrow(ProviderProtocolError);
  });

  it("refuses a host-only message type inbound", () => {
    expect(() => parseProviderFrame(providerMessage("invoke", { input: {}, operationContext: {} })))
      .toThrow(ProviderProtocolError);
  });

  it("refuses an unknown extra envelope field", () => {
    expect(() => parseProviderFrame(providerMessage("cancel-ack", { rogue: 1 })))
      .toThrow(ProviderProtocolError);
  });

  it("refuses a missing required field", () => {
    const message = providerMessage("error", { code: "provider-failed" });
    expect(() => parseProviderFrame(message)).toThrow(ProviderProtocolError);
  });

  it("refuses an unknown problem code in an error frame", () => {
    expect(() => parseProviderFrame(providerMessage("error", { code: "not-a-code", detail: "x" })))
      .toThrow(ProviderProtocolError);
  });

  it("refuses a non-object frame", () => {
    expect(() => parseProviderFrame(42)).toThrow();
  });

  it("refuses a negative sequence", () => {
    expect(() => parseProviderFrame(providerMessage("cancel-ack", { sequence: -1 } as never)))
      .toThrow(ProviderProtocolError);
  });

  it("refuses a checkpoint whose byte count disagrees with its bytes", () => {
    const message = providerMessage("checkpoint", { checkpointBase64: Buffer.from("abc").toString("base64"), byteCount: 99 });
    expect(() => parseProviderFrame(message)).toThrow(ProviderProtocolError);
  });

  it("parses a valid progress frame", () => {
    const parsed = parseProviderFrame(providerMessage("progress", { completed: 1, total: 2, note: null }));
    expect(parsed.event.type).toBe("progress");
  });
});
