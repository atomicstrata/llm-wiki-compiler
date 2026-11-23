/**
 * @file src/portable/originals/grammar.ts
 * @description What a well-formed frame stream of each method looks like, so
 * a client never takes a malformed or truncated stream for a complete one.
 *
 * - a ranged read: one `range` frame, data frames totalling EXACTLY its
 *   `end - start` bytes, then `end`;
 * - an export: any number of `object` frames, each followed by data frames
 *   totalling exactly its `byteCount`, then `completed` — never inside an
 *   unfinished object body, and naming exactly the number of objects received;
 * - a range header lies within its object: `0 ≤ start ≤ end ≤ byteCount`.
 *
 * A `refused` frame may end either stream at any point. After the terminal
 * frame nothing may follow, not even a partial frame: the connection must end
 * there, with the decoder holding nothing.
 */

import { FrameError, type Frame } from "./frames.js";

/** The two frame-stream methods. */
export type StreamKind = "read" | "export";

/** Checks one stream's frames, in order, against its method's grammar. */
export class StreamGrammar {
  /** Payload bytes still owed to the current range or object; `null` between objects. */
  private owed: number | null = null;
  private started = false;
  private ended = false;
  /** Objects whose whole body arrived: what a `completed` count must equal. */
  private objects = 0;

  constructor(private readonly kind: StreamKind) {}

  /** True once a terminal frame was accepted. */
  get isEnded(): boolean {
    return this.ended;
  }

  /**
   * Accept the next frame.
   *
   * @throws FrameError for any frame the method's grammar does not allow here.
   */
  accept(frame: Frame): void {
    const { header } = frame;
    if (this.ended) throw new FrameError("a frame after the terminal frame");
    if (header.kind === "refused") { this.ended = true; return; }
    if (header.kind === "data") { this.payload(header.bytes); return; }
    if (this.owed !== null && this.owed > 0) throw new FrameError("an object body ended early");
    this.boundary(frame);
  }

  /** Account one data frame against the body it belongs to. */
  private payload(bytes: number): void {
    if (this.owed === null || bytes > this.owed) throw new FrameError("payload outside a declared body");
    this.owed -= bytes;
    if (this.owed === 0 && this.kind === "export") { this.objects += 1; this.owed = null; }
  }

  /** A range header: it must lie within its object, `0 ≤ start ≤ end ≤ byteCount`. */
  private openRange(start: number, end: number, byteCount: number): void {
    if (!(start >= 0 && start <= end && end <= byteCount)) throw new FrameError("a range outside its object");
    this.started = true;
    this.owed = end - start;
  }

  /** An object header: an empty object is complete at once. */
  private openObject(byteCount: number): void {
    this.owed = byteCount;
    if (byteCount === 0) { this.objects += 1; this.owed = null; }
  }

  /** A frame between bodies: a range or object header, or a successful terminal. */
  private boundary(frame: Frame): void {
    const { header } = frame;
    if (this.kind === "read") {
      if (header.kind === "range" && !this.started) { this.openRange(header.start, header.end, header.byteCount); return; }
      if (header.kind === "end" && this.started) { this.ended = true; return; }
    } else {
      if (header.kind === "object") { this.openObject(header.byteCount); return; }
      if (header.kind === "completed" && header.count === this.objects) { this.ended = true; return; }
    }
    throw new FrameError(`a ${header.kind} frame is not allowed here`);
  }
}
