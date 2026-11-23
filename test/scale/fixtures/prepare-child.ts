/**
 * @file test/scale/fixtures/prepare-child.ts
 * @description A child process that sets an indexed expected scale through
 * the real set body on real disk and SIGKILLs ITSELF right after the named
 * durable checkpoint, leaving whatever that point left on disk.
 */

import { diskScaleTransitionSteps, setExpectedScaleWith } from "../../../src/scale/transition.js";

/** Run to `stage`, then die without unwinding. */
async function main(): Promise<void> {
  const [root, stage] = process.argv.slice(2) as [string, string];
  const disk = diskScaleTransitionSteps(root);
  await setExpectedScaleWith({
    ...disk, preflight: { freeBytes: async () => Number.MAX_SAFE_INTEGER },
    checkpoint: async (at) => { if (at === stage) process.kill(process.pid, "SIGKILL"); },
  }, { request: { documents: 8_000 } });
  console.log(JSON.stringify({ outcome: "finished" }));
}

await main();
