/**
 * @file src/portable/originals/client.ts
 * @description The client of `portable-originals/2` over a host: control
 * calls, a streamed upload, and frame streams decoded incrementally.
 *
 * Nothing is collected whole. An upload is sent as a request stream that pulls
 * from the caller's source as the connection accepts it. A read or export is
 * consumed one network chunk at a time — the next chunk is requested only when
 * the caller asks for the next frame — through a decoder with one fixed
 * buffer, so a slow consumer leaves the bytes in the transport and the host
 * stops producing. Every stream answers with an explicit terminal frame; a
 * stream that ends without one throws rather than looking complete.
 *
 * A parsed control or stage body is not yet an answer: it must be the
 * method's own established answer or this protocol's closed refusal, or the
 * call throws. A staged add is a write and settles as `unknown` under the held
 * operation id instead (see `client-outcomes.ts`).
 */

import { establishedAnswer, isNegotiation, isOriginalStatOf, isStageStep, settleStagedAdd } from "./client-outcomes.js";
import { FrameDecoder, FrameError, type Frame } from "./frames.js";
import { StreamGrammar } from "./grammar.js";
import { SCALE_PROTOCOL_HEADER } from "../scale/wire.js";
import {
  ORIGINALS_PATH_PREFIX, ORIGINALS_PROTOCOL_V2, type AddStagedOutcomeV2, type AddStagedRequestV2, type OriginalStatV2, type OriginalsNegotiationV2,
  type OriginalsRefusedV2, type StagedHandleV2, type TerminalFrameV2,
} from "./contracts.js";

/** Where a project is served and the credential to reach it with. */
export interface OriginalsTarget { host: string; project: string; token: string }

/** What a client decoded, for evidence: the largest buffer the decoder held. */
export interface ClientCounters { maxParserBuffer: number; networkChunks: number; bytesReceived: number }

/** The URL and headers of one method call. */
function request(target: OriginalsTarget, method: string, query = ""): { url: string; headers: Record<string, string> } {
  return {
    url: `${target.host}${ORIGINALS_PATH_PREFIX}${encodeURIComponent(target.project)}/${method}${query}`,
    headers: { authorization: `Bearer ${target.token}`, [SCALE_PROTOCOL_HEADER]: ORIGINALS_PROTOCOL_V2 },
  };
}

/** One control call with a small JSON body: the parsed body, not yet an established answer. */
async function control(target: OriginalsTarget, method: string, body: unknown = {}): Promise<unknown> {
  const { url, headers } = request(target, method);
  const response = await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.json();
}

/**
 * The frames of one stream, decoded as they arrive. The final frame is always
 * terminal.
 *
 * @throws FrameError when the stream ends without a terminal frame or is malformed.
 */
async function* frameStream(target: OriginalsTarget, method: string, body: unknown, counters: ClientCounters): AsyncGenerator<Frame> {
  const { url, headers } = request(target, method);
  const response = await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (response.body === null) throw new FrameError("no stream");
  const reader = response.body.getReader();
  const decoder = new FrameDecoder();
  const grammar = new StreamGrammar(method === "export" ? "export" : "read");
  try {
    // Read to the very end, even past the terminal frame: anything after it — a frame, a partial frame — is malformed.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      counters.networkChunks += 1;
      counters.bytesReceived += value.byteLength;
      if (grammar.isEnded) throw new FrameError("bytes after the terminal frame");
      for (const frame of decoder.push(value)) {
        grammar.accept(frame);
        counters.maxParserBuffer = Math.max(counters.maxParserBuffer, decoder.maxBuffered);
        yield frame;
      }
    }
    if (!grammar.isEnded || !decoder.idle) throw new FrameError("stream ended without a complete terminal frame");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** A staged upload's answer: the sealed handle, or this protocol's refusal. */
export type StageOutcomeV2 = StagedHandleV2 | OriginalsRefusedV2;

/** The originals client of one project. */
export interface OriginalsClientV2 {
  readonly counters: ClientCounters;
  negotiate(): Promise<OriginalsNegotiationV2>;
  /** Open, stream and seal one stage for `operationId`. */
  stage(request: { operationId: string; declaredBytes: number; source: AsyncIterable<Uint8Array>; ttlMs?: number }): Promise<StageOutcomeV2>;
  addStaged(request: AddStagedRequestV2): Promise<AddStagedOutcomeV2>;
  stat(name: string): Promise<OriginalStatV2 | OriginalsRefusedV2>;
  /** A ranged read: a `range` frame, data frames, then exactly one terminal frame. */
  read(name: string, range?: { start?: number; end?: number }): AsyncGenerator<Frame>;
  /** The streamed export: object and data frames, then exactly one terminal frame. */
  export(): AsyncGenerator<Frame>;
}

/** Upload one stage's bytes as a request stream: the parsed body, not yet an established answer. */
async function append(target: OriginalsTarget, step: { handle: string; operationId: string }, source: AsyncIterable<Uint8Array>): Promise<unknown> {
  const query = `?handle=${encodeURIComponent(step.handle)}&operation=${encodeURIComponent(step.operationId)}&offset=0`;
  const { url, headers } = request(target, "stage.append", query);
  const iterator = source[Symbol.asyncIterator]();
  // Pulled only when the connection asks for more: the source is never read ahead into a queue.
  const body = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const next = await iterator.next();
      if (next.done === true) controller.close(); else controller.enqueue(next.value);
    },
    cancel: async () => { await iterator.return?.(); },
  }, { highWaterMark: 0 });
  const response = await fetch(url, { method: "PUT", headers, body, duplex: "half" } as RequestInit);
  return response.json();
}

/**
 * Open, stream and seal one stage. Each step's answer is established before the
 * next — the held handle, at the declared size, in the step's state — and a
 * refusal ends the stage.
 *
 * @throws Error when the host did not establish a step's answer.
 */
async function stageUpload(target: OriginalsTarget, upload: Parameters<OriginalsClientV2["stage"]>[0]): Promise<StageOutcomeV2> {
  const { operationId, declaredBytes } = upload;
  const openAnswer = await control(target, "stage.open", { operationId, declaredBytes, ttlMs: upload.ttlMs });
  const opened = establishedAnswer<StagedHandleV2>("stage.open", openAnswer, isStageStep({ step: "opened", declaredBytes }));
  if (opened.kind !== "staged") return opened;
  const held = { handle: opened.handle, declaredBytes };
  const appendAnswer = await append(target, { handle: held.handle, operationId }, upload.source);
  const appended = establishedAnswer<StagedHandleV2>("stage.append", appendAnswer, isStageStep({ ...held, step: "appended" }));
  if (appended.kind !== "staged") return appended;
  const sealAnswer = await control(target, "stage.seal", { handle: held.handle, operationId });
  return establishedAnswer<StagedHandleV2>("stage.seal", sealAnswer, isStageStep({ ...held, step: "sealed" }));
}

/** The client of `target`. */
export function originalsClient(target: OriginalsTarget): OriginalsClientV2 {
  const counters: ClientCounters = { maxParserBuffer: 0, networkChunks: 0, bytesReceived: 0 };
  return {
    counters,
    negotiate: async () => establishedAnswer<OriginalsNegotiationV2>("negotiate", await control(target, "negotiate"), isNegotiation),
    stage: (upload) => stageUpload(target, upload),
    addStaged: (staged) => settleStagedAdd(staged, () => control(target, "sources.addStaged", staged)),
    stat: async (name) => establishedAnswer<OriginalStatV2>("originals.stat", await control(target, "originals.stat", { name }), isOriginalStatOf(name)),
    read: (name, range = {}) => frameStream(target, "originals.read", { name, ...range }, counters),
    export: () => frameStream(target, "export", {}, counters),
  };
}

/** True for a terminal frame header. */
export function isTerminal(frame: Frame): frame is Frame & { header: TerminalFrameV2 } {
  return frame.header.kind === "completed" || frame.header.kind === "end" || frame.header.kind === "refused";
}
