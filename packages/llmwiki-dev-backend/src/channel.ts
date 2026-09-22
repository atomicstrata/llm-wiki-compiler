/**
 * @file packages/llmwiki-dev-backend/src/channel.ts
 * @description The stdio transport half of the local development backend: a
 * child process presented as a `ProviderBackendChannelV1`.
 *
 * IT IS A TRANSPORT, NOT A PROTOCOL. `send` receives an ALREADY-ENCODED frame
 * and writes those bytes verbatim; `receive` returns raw stdout chunks and lets
 * the runtime's own decoder find frame boundaries. Re-framing here would put a
 * second, divergent implementation of the wire format behind the one the
 * runtime validates against.
 *
 * A CLOSED STREAM IS `null`, NOT AN ERROR. The runtime distinguishes "stream
 * ended" from "stream broke" itself — it admits a terminal result on close and
 * refuses one on truncation — so collapsing the two here would take that
 * decision away from the layer that owns it.
 *
 * STDERR IS BOUNDED AND NEVER PARSED. A provider that writes without limit must
 * not exhaust host memory, so capture stops at a cap; the retained head is for
 * a human reading a failure, never for control flow.
 */

import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** The subset of the runtime's channel contract this transport implements. */
export interface DevBackendChannelV1 {
  send(frame: Buffer): Promise<void>;
  receive(): Promise<Buffer | null>;
  outputRoot(): Promise<string>;
  terminate(): Promise<void>;
}

/** What one launched child needs to become a channel. */
export interface DevChannelInputV1 {
  readonly child: ChildProcessWithoutNullStreams;
  readonly outputRoot: string;
  /**
   * Additional per-invocation directories this channel OWNS and must remove on
   * termination alongside the output root — e.g. a private scratch root created
   * for the child. Created once per launch, needed by nothing after the run, so
   * left unremoved they grow without bound across a session.
   */
  readonly scratchRoots?: readonly string[];
  readonly maximumCapturedStderrBytes: number;
  /** Wall-time ceiling; the child is terminated when it elapses. */
  readonly wallTimeMs: number;
}

/**
 * A queue that hands stdout chunks to a single consumer, in order, and reports
 * end-of-stream exactly once per waiting reader.
 */
class ChunkQueue {
  private readonly chunks: Buffer[] = [];
  private readonly waiting: ((chunk: Buffer | null) => void)[] = [];
  private closed = false;

  push(chunk: Buffer): void {
    const waiter = this.waiting.shift();
    if (waiter !== undefined) waiter(chunk);
    else this.chunks.push(chunk);
  }

  close(): void {
    this.closed = true;
    // Every pending reader learns the stream ended; a reader arriving later
    // drains the buffered chunks first and only then sees the close.
    while (this.waiting.length > 0) this.waiting.shift()?.(null);
  }

  take(): Promise<Buffer | null> {
    const buffered = this.chunks.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

/** Present one launched child process as a provider backend channel. */
export function createDevChannel(input: DevChannelInputV1): DevBackendChannelV1 {
  const queue = new ChunkQueue();
  let stderrBytes = 0;
  const stderrHead: Buffer[] = [];
  let terminated = false;

  input.child.stdout.on("data", (chunk: Buffer) => queue.push(chunk));
  input.child.stdout.on("end", () => queue.close());
  input.child.on("close", () => queue.close());
  // An error (spawn failure, EPIPE) ends the stream rather than throwing into a
  // listener with nowhere to report: the runtime reads the close as a provider
  // that never reached a terminal frame, which is exactly what happened.
  input.child.on("error", () => queue.close());
  input.child.stderr.on("data", (chunk: Buffer) => {
    const remaining = input.maximumCapturedStderrBytes - stderrBytes;
    if (remaining <= 0) return;
    const kept = chunk.subarray(0, remaining);
    stderrHead.push(kept);
    stderrBytes += kept.byteLength;
  });

  const terminate = async (): Promise<void> => {
    if (terminated) return;
    terminated = true;
    clearTimeout(deadline);
    input.child.kill("SIGKILL");
    queue.close();
    // THE OUTPUT ROOT IS THIS CHANNEL'S TO REMOVE. It is created per invocation,
    // and the runtime has already custodied whatever it admitted by the time
    // this disposer runs — so anything still here is a copy the host no longer
    // needs. Leaving it behind grows without bound across a long session, one
    // directory per provider phase.
    //
    // A cleanup failure is SWALLOWED because it must not change the invocation's
    // outcome: the answer was already admitted or refused on its own merits, and
    // failing here would rewrite a completed result as an error. The scratch
    // roots are removed on the same footing — they are this channel's to own.
    const roots = [input.outputRoot, ...(input.scratchRoots ?? [])];
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => {})));
  };

  // The DEADLINE is the backend's, not the provider's: a provider that hangs
  // must not hold the run open, and the runtime's own cancellation cannot help
  // if the child never reads its cancel frame.
  const deadline = setTimeout(() => void terminate(), input.wallTimeMs);
  deadline.unref?.();

  return {
    async send(frame: Buffer): Promise<void> {
      if (terminated) return;
      await new Promise<void>((resolve) => {
        // A write to a dead child surfaces as the closed stream the reader
        // already observes; failing the send would report the wrong cause.
        input.child.stdin.write(frame, () => resolve());
      });
    },
    receive: () => queue.take(),
    outputRoot: async () => input.outputRoot,
    terminate,
  };
}

/** Spawn one provider child (no shell) and wrap it in the standard channel — the launch tail every backend shares. */
export function launchProviderChannel(input: {
  command: string; args: readonly string[]; cwd: string; env: Record<string, string>;
  outputRoot: string; scratchRoots?: readonly string[];
  maximumCapturedStderrBytes: number; wallTimeMs: number;
}): DevBackendChannelV1 {
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    // NO SHELL: nothing in the path or arguments is interpreted.
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: input.env,
  });
  return createDevChannel({
    child, outputRoot: input.outputRoot,
    ...(input.scratchRoots === undefined ? {} : { scratchRoots: input.scratchRoots }),
    maximumCapturedStderrBytes: input.maximumCapturedStderrBytes, wallTimeMs: input.wallTimeMs,
  });
}
