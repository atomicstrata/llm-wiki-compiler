/**
 * @file src/segments/counters.ts
 * @description Per-operation I/O counters for the durable local stores and the
 * bounded routes built on them.
 *
 * Each counter is incremented where the work actually happens: a manifest
 * read and its bytes (a flat manifest grows with the segment count), a segment opened, the bytes read from it, a block decoded, a row
 * parsed, a source or page file read, a file stat'd, a directory listed. They
 * are evidence that a narrow operation did not scan globally. Rows RETURNED
 * are counted separately and are never a proxy for rows read.
 *
 * OBSERVATION. {@link observeIo} runs a real public operation (an SDK method,
 * a CLI action) while every store it opens without explicit counters adds to
 * one observed set, so measurements count the work of the actual selected
 * route rather than of a test-only call.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Work one operation performed. All fields only ever grow. */
export interface IoCounters {
  manifestReads: number;
  manifestBytesRead: number;
  segmentsOpened: number;
  segmentBytesRead: number;
  blocksRead: number;
  rowsDecoded: number;
  rowsReturned: number;
  segmentsWritten: number;
  segmentBytesWritten: number;
  manifestsPublished: number;
  filesStatted: number;
  bodiesRead: number;
  directoriesListed: number;
  /**
   * PHYSICAL work at the raw store-IO boundary during the VERIFICATION
   * PHASE of each store, counted only where a verification wraps its stores
   * (`./verification-cache.ts`); zero elsewhere. Each store's opening
   * manifest read (before its snapshot exists) is NOT included here: it is in
   * `manifestReads`/`manifestBytesRead`, and directory discovery in
   * `directoriesListed`/`filesStatted`. The logical counters above
   * (`segmentsOpened`, `segmentBytesRead`, `blocksRead`) keep counting what
   * the readers asked for, including reads a verification cache answered
   * from memory.
   */
  physicalManifestReads: number;
  physicalSegmentOpens: number;
  physicalSegmentBytesRead: number;
  physicalListings: number;
  /** Reader-lease checks: one per physical manifest read and segment open (each re-checks this process's lease). */
  leaseChecks: number;
  /** Verification-cache reads answered from memory, read from disk, and slices evicted. */
  cacheHits: number;
  cacheMisses: number;
  cacheEvictions: number;
}

/** A fresh, zeroed counter set. */
export function newCounters(): IoCounters {
  return {
    manifestReads: 0, manifestBytesRead: 0, segmentsOpened: 0, segmentBytesRead: 0, blocksRead: 0, rowsDecoded: 0, rowsReturned: 0,
    segmentsWritten: 0, segmentBytesWritten: 0, manifestsPublished: 0, filesStatted: 0, bodiesRead: 0, directoriesListed: 0,
    physicalManifestReads: 0, physicalSegmentOpens: 0, physicalSegmentBytesRead: 0, physicalListings: 0, leaseChecks: 0,
    cacheHits: 0, cacheMisses: 0, cacheEvictions: 0,
  };
}


const observed = new AsyncLocalStorage<IoCounters>();

/** Run `work` with every store opened inside it (without explicit counters) counting into `counters`. */
export function observeIo<T>(counters: IoCounters, work: () => Promise<T>): Promise<T> {
  return observed.run(counters, work);
}

/** The counters a store opened now should use: the observed set, or a fresh one. */
export function ambientCounters(): IoCounters {
  return observed.getStore() ?? newCounters();
}
