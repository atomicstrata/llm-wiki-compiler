/**
 * @file src/compiler/batch/page-writes.ts
 * @description BYTE-BOUNDED page write batches of a batch compile: every page
 * the run writes (deletion orphans, generated pages, resolution and repair
 * rewrites) goes through the incumbent journalled compile page write
 * (`applyCompilePageWritesLocked`), in batches of at most
 * {@link MAX_BATCH_PAGE_BYTES} of bodies and {@link MAX_BATCH_PAGES} pages, so
 * no phase holds more page bodies than one batch. Each applied batch is
 * reported (what was written, what the floor skipped) to the caller, which
 * records its progress; a crash replays from the caller's last checkpoint
 * and the incumbent page steps are idempotent for what was already written.
 */

import { applyCompilePageWritesLocked, type CompilePageWrite, type SkippedWrite } from "../compile-write.js";
import { BatchCompileError } from "./contracts.js";
import { MAX_PAGE_BYTES } from "./pages.js";

/** Most page-body bytes one batch holds before it is applied. */
const MAX_BATCH_PAGE_BYTES = 8 * 1024 * 1024;
/** Most pages one batch holds before it is applied. */
const MAX_BATCH_PAGES = 256;

/** What one applied batch wrote and skipped. */
export type AppliedBatch = (written: readonly CompilePageWrite[], skipped: readonly SkippedWrite[]) => Promise<void>;

/** A byte-bounded batcher of compile page writes under the caller's held lock. */
export class PageWriteBatcher {
  private writes: CompilePageWrite[] = [];
  private bytes = 0;

  constructor(private readonly root: string, private readonly applied: AppliedBatch = async () => {}) {}

  /** Add one write (a page above the batch page cap refuses); applies the batch first when the write would pass either bound. */
  async add(write: CompilePageWrite): Promise<void> {
    const bytes = Buffer.byteLength(write.body);
    if (bytes > MAX_PAGE_BYTES) throw new BatchCompileError("compile_batch_page_too_large", `${write.namespace}/${write.slug}.md would be ${bytes} bytes, over the ${MAX_PAGE_BYTES}-byte batch page cap`);
    if (this.bytes + bytes > MAX_BATCH_PAGE_BYTES || this.writes.length >= MAX_BATCH_PAGES) await this.flush();
    this.writes.push(write);
    this.bytes += bytes;
  }

  /** Apply what is buffered (nothing when empty). */
  async flush(): Promise<void> {
    if (this.writes.length === 0) return;
    const batch = this.writes;
    this.writes = [];
    this.bytes = 0;
    const { skipped } = await applyCompilePageWritesLocked(this.root, batch);
    const skippedKeys = new Set(skipped.map((item) => `${item.item.namespace}/${item.item.slug}`));
    await this.applied(batch.filter((write) => !skippedKeys.has(`${write.namespace}/${write.slug}`)), skipped);
  }
}
