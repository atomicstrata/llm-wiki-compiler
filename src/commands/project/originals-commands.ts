/**
 * @file src/commands/project/originals-commands.ts
 * @description The handlers behind `llmwiki project originals …`: slice S3's
 * operator journey against a host that offers retained originals.
 *
 * `add` streams a file from disk into a stage — never reading it whole — seals
 * it and publishes it as a source with its original retained; `stat` shows an
 * original's metadata; `read` writes a range of it to a file; `export` writes
 * the whole project to a file, finalized only after the export's completed
 * fence. These commands are clients of a host that offers retained originals;
 * this package ships no such host, and a local directory answers with a typed
 * refusal. Every command prints one JSON document and exits non-zero unless the
 * operation reached its success arm.
 */

import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { PortableHostError } from "../../portable/errors.js";
import { exportToFile, finalizePartialNoReplace, openOriginalsProject, writeAll } from "../../portable/originals/open.js";
import type { OriginalsClientV2 } from "../../portable/originals/client.js";
import { ORIGINALS_LIMITS, ORIGINALS_PROTOCOL_V2 } from "../../portable/originals/contracts.js";
import { openCommandSession, reportCommand, type ProjectRef } from "./session.js";

/** Environment variable a host token may be supplied through. */
const TOKEN_ENV = "LLMWIKI_PROJECT_TOKEN";

/** The client of a hosted `--project` reference. */
function clientOf(ref: ProjectRef): OriginalsClientV2 {
  if (!ref.project || !/^https?:\/\//u.test(ref.project)) throw new PortableHostError("retained originals need a hosted --project <url>/<project>");
  const url = new URL(ref.project);
  const token = ref.token ?? process.env[TOKEN_ENV];
  if (!token) throw new PortableHostError(`a hosted project needs --token or ${TOKEN_ENV}`);
  return openOriginalsProject({
    project: { host: url.origin, project: url.pathname.replace(/^\/+|\/+$/gu, "") },
    credential: { kind: "host-token", token }, protocols: [ORIGINALS_PROTOCOL_V2],
  });
}

/** `project originals add <file>`: stage the file in chunks, seal it, publish it as a source. */
export function projectOriginalsAddCommand(file: string, options: ProjectRef & { name?: string }): Promise<number> {
  return reportCommand(async () => {
    const client = clientOf(options);
    const session = await openCommandSession(options);
    const operationId = await session.project.allocateOperation();
    console.error(`operation: ${operationId}`);
    const declaredBytes = (await stat(file)).size;
    const source = createReadStream(file, { highWaterMark: ORIGINALS_LIMITS.maxChunkBytes }) as AsyncIterable<Uint8Array>;
    const staged = await client.stage({ operationId, declaredBytes, source });
    if (staged.kind !== "staged" || staged.digest === undefined) return staged;
    return client.addStaged({ operationId, name: options.name ?? path.basename(file), handle: staged.handle, digest: staged.digest });
  });
}

/** `project originals stat <name>` */
export function projectOriginalsStatCommand(name: string, options: ProjectRef): Promise<number> {
  return reportCommand(() => clientOf(options).stat(name));
}

/** `project originals read <name> --out <file>`: write a range to a file, finalized only after its `end` frame. */
export function projectOriginalsReadCommand(name: string, options: ProjectRef & { out: string; start?: string; end?: string }): Promise<number> {
  return reportCommand(async () => {
    const range = { start: options.start === undefined ? undefined : Number(options.start), end: options.end === undefined ? undefined : Number(options.end) };
    const partial = `${options.out}.partial`;
    const file = await open(partial, "wx");
    let terminal: { kind: string } = { kind: "unknown" };
    try {
      for await (const frame of clientOf(options).read(name, range)) {
        if (frame.payload !== undefined) await writeAll(file, frame.payload);
        terminal = frame.header;
      }
    } finally {
      await file.close();
    }
    if (terminal.kind === "end") await finalizePartialNoReplace(partial, options.out);
    return terminal;
  });
}

/** `project originals export --out <file>` */
export function projectOriginalsExportCommand(options: ProjectRef & { out: string }): Promise<number> {
  return reportCommand(() => exportToFile(clientOf(options), options.out));
}
