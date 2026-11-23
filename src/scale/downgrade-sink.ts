/**
 * @file src/scale/downgrade-sink.ts
 * @description Where the bytes of one scale-down EXPORT go: an indexed
 * authority (the segmented event or relation log, a workspace operation
 * catalog, the segmented compile state, the piecewise vector store) streamed
 * back into the incumbent single-file format of the smaller layout.
 *
 * ONE SERIALIZER, TWO SINKS. Every export runs the same code against a sink:
 * a COUNTING sink (the read-only preview: it measures the exact byte size and
 * digest the stage would write, holding nothing), or a WRITING sink (the
 * stage: the same bytes handed on in bounded chunks to a create-only durable
 * file). The measured size is therefore the real size of the file, never an
 * estimate. A writing sink refuses the first byte beyond the incumbent cap of
 * its file (`downgrade_export_too_large`); a counting sink keeps counting, so
 * the preview can report how far over the cap the authority is.
 */

import { createHash, type Hash } from "node:crypto";

/** Buffered bytes a writing sink hands on at once. */
const FLUSH_BYTES = 1024 * 1024;

/** Why an export cannot be represented in the incumbent file. */
export type DowngradeExportCode = "downgrade_export_too_large" | "downgrade_export_mismatch" | "downgrade_export_unsupported";

/** A typed refusal of one export; nothing the export wrote is authoritative. */
export class DowngradeExportError extends Error {
  constructor(readonly code: DowngradeExportCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "DowngradeExportError";
  }
}

/** What one export produced (or would produce) for one incumbent file. */
export interface ExportedFile {
  /** The incumbent file's project-relative path. */
  readonly relPath: string;
  /** False when the smaller layout holds no file here (an empty authority that had no incumbent file). */
  readonly present: boolean;
  readonly bytes: number;
  /** SHA-256 of exactly the bytes, or null when absent. */
  readonly sha256: string | null;
  /** Authoritative records the bytes hold. */
  readonly records: number;
  /** The incumbent cap of this file. */
  readonly cap: number;
}

/** One export's byte stream: counted, hashed, and (when writing) handed on in bounded chunks. */
export class ExportSink {
  private bytes = 0;
  private readonly hash: Hash = createHash("sha256");
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  /**
   * @param relPath - The incumbent file the bytes are for.
   * @param cap - The incumbent cap of that file.
   * @param write - Absent for a counting sink; otherwise receives every chunk in order.
   */
  constructor(readonly relPath: string, readonly cap: number, private readonly write?: (chunk: Buffer) => Promise<void>) {}

  /** Append `data`; a writing sink refuses the first byte beyond the cap. */
  async push(data: string | Buffer): Promise<void> {
    const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    this.bytes += chunk.byteLength;
    this.hash.update(chunk);
    if (this.write === undefined) return;
    if (this.bytes > this.cap) throw new DowngradeExportError("downgrade_export_too_large", `${this.relPath} would exceed its ${this.cap}-byte cap`);
    this.pending.push(chunk);
    this.pendingBytes += chunk.byteLength;
    if (this.pendingBytes >= FLUSH_BYTES) await this.flush();
  }

  /** Hand on every buffered chunk. */
  async flush(): Promise<void> {
    if (this.write === undefined || this.pending.length === 0) return;
    const chunk = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    await this.write(chunk);
  }

  /** The finished export of `records` records (the sink flushed first). */
  async finish(records: number): Promise<ExportedFile> {
    await this.flush();
    return { relPath: this.relPath, present: true, bytes: this.bytes, sha256: this.hash.digest("hex"), records, cap: this.cap };
  }

  /** The export of an authority the smaller layout holds no file for; nothing may have been pushed. */
  absent(): ExportedFile {
    if (this.bytes > 0) throw new DowngradeExportError("downgrade_export_mismatch", `${this.relPath} cannot be absent after bytes were exported`);
    return { relPath: this.relPath, present: false, bytes: 0, sha256: null, records: 0, cap: this.cap };
  }
}
