/**
 * @file test/dev-backend/channel-scratch-cleanup.test.ts
 * @description The dev channel OWNS its per-invocation directories: terminate()
 * removes the output root AND every declared scratch root. A scratch root is
 * created once per launch and needed by nothing after the run, so a channel
 * that cleaned only the output root leaked one directory per invocation — which
 * is exactly what the limited-isolation backend did before it declared its
 * scratch root to the channel.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createDevChannel } from "../../packages/llmwiki-dev-backend/src/channel.js";

/** A child that does nothing — enough for the channel to attach and terminate. */
function inertChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter();
  Object.assign(child, {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: { write: (_frame: Buffer, cb: () => void) => cb() },
    kill: () => true,
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

const leftovers: string[] = [];
afterEach(async () => {
  await Promise.all(leftovers.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
  leftovers.length = 0;
});

describe("the dev channel removes every root it owns on terminate", () => {
  it("removes the scratch roots alongside the output root, leaving nothing behind", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "chan-out-"));
    const scratchRoot = await mkdtemp(path.join(tmpdir(), "chan-scratch-"));
    leftovers.push(outputRoot, scratchRoot); // reclaimed even if an assertion below throws
    const channel = createDevChannel({
      child: inertChild(), outputRoot, scratchRoots: [scratchRoot],
      maximumCapturedStderrBytes: 1024, wallTimeMs: 60_000,
    });
    await channel.terminate();
    expect(existsSync(outputRoot), "output root leaked").toBe(false);
    expect(existsSync(scratchRoot), "scratch root leaked").toBe(false);
  });
});
