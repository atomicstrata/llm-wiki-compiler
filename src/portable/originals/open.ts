/**
 * @file src/portable/originals/open.ts
 * @description The SDK entry points of slice S3: open a project's
 * retained-originals surface, stating `portable-originals/2`, and export it to
 * a file — beside `openProject`, which is unchanged.
 *
 * The surface is served by a host (the simulated host in S3). A local
 * registered directory has no retained-original format: its surface refuses
 * every method with `capability_unsupported`, naming `stagedWrites`, rather
 * than collect and slice or raise a version 1 cap.
 *
 * Export to a file writes the frame stream to `<path>.partial` as it arrives
 * and publishes it to `<path>` only after the `completed` frame, the fence the
 * export's completeness rests on. A stream that ended any other way leaves the
 * partial file named as partial and answers with its terminal refusal.
 */

import { link, open, unlink, type FileHandle } from "node:fs/promises";
import { ACCESS_NOTICE } from "../contracts.js";
import { originalsClient, isTerminal, type OriginalsClientV2, type OriginalsTarget } from "./client.js";
import { ORIGINALS_CAPABILITY, ORIGINALS_PROTOCOL_V2, type OriginalsRefusedV2, type TerminalFrameV2 } from "./contracts.js";
import { encodeFrame, FrameError, type Frame } from "./frames.js";

/** What `openOriginalsProject` needs. */
export interface OpenOriginalsOptions {
  project: { host: string; project: string } | { localRoot: string };
  credential: { kind: "host-token"; token: string } | { kind: "local-os" };
  /** Must include `portable-originals/2`. Nothing is inferred from its absence. */
  protocols: readonly string[];
}

const UNSUPPORTED: OriginalsRefusedV2 = { kind: "refused", code: "capability_unsupported", capability: ORIGINALS_CAPABILITY, notice: ACCESS_NOTICE };

/** One terminal refusal frame, as a stream. */
async function* refusedStream(): AsyncGenerator<Frame> {
  yield { header: { kind: "refused", code: "capability_unsupported", bytes: 0 } };
}

/** The surface of a project with no retained-original format: every method refuses by name. */
function unsupportedClient(): OriginalsClientV2 {
  return {
    counters: { maxParserBuffer: 0, networkChunks: 0, bytesReceived: 0 },
    negotiate: async () => UNSUPPORTED, stage: async () => UNSUPPORTED, addStaged: async () => UNSUPPORTED,
    stat: async () => UNSUPPORTED, read: refusedStream, export: refusedStream,
  };
}

/**
 * Open the retained-originals surface of a project.
 *
 * @throws TypeError when the caller does not state the protocol, or a hosted project lacks a host token.
 */
export function openOriginalsProject(options: OpenOriginalsOptions): OriginalsClientV2 {
  if (!options.protocols.includes(ORIGINALS_PROTOCOL_V2)) {
    throw new TypeError(`openOriginalsProject requires the caller to state the ${ORIGINALS_PROTOCOL_V2} protocol`);
  }
  if ("localRoot" in options.project) return unsupportedClient();
  if (options.credential.kind !== "host-token") throw new TypeError("a hosted project needs a host token");
  const target: OriginalsTarget = { ...options.project, token: options.credential.token };
  return originalsClient(target);
}

/** Write every byte of `bytes`, however short each underlying write turns out. */
export async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset);
    // A write that accepts nothing would loop forever: it is a failure, not progress.
    if (bytesWritten <= 0) throw new FrameError("the export file accepted no bytes");
    offset += bytesWritten;
  }
}

/**
 * Export a project to `path`: frames are written to `<path>.partial` as they
 * arrive, and the file is published to `path` only after the completed fence.
 *
 * @returns The stream's terminal frame.
 */
export async function exportToFile(client: OriginalsClientV2, path: string): Promise<TerminalFrameV2> {
  const partial = `${path}.partial`;
  const file = await open(partial, "wx");
  let terminal: TerminalFrameV2 | null = null;
  try {
    // The client's stream throws on any malformed or trailing byte, so the loop ends normally only at a clean EOF.
    for await (const frame of client.export()) {
      await writeAll(file, encodeFrame(frame));
      if (isTerminal(frame)) terminal = frame.header;
    }
  } finally {
    await file.close();
  }
  if (terminal === null) throw new FrameError("stream ended without a terminal frame");
  if (terminal.kind === "completed") await finalizePartialNoReplace(partial, path);
  return terminal;
}

/** Publish a completed same-directory partial without replacing an occupied destination. */
export async function finalizePartialNoReplace(partial: string, destination: string): Promise<void> {
  await link(partial, destination);
  await unlink(partial);
}
