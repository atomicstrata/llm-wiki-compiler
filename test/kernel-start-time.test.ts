/**
 * @file test/kernel-start-time.test.ts
 * @description The in-process kernel start-time read must give exactly the
 * second `ps -o lstart=` renders, for this process and for foreign ones.
 *
 * A single second of disagreement would make a live lock holder read as a
 * reused pid — and old builds, which still ask `ps`, would disagree with new
 * ones on the same host. So the equivalence is checked against `ps` itself, the
 * reader every other build uses, rather than against a re-derivation.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "bun:test";
import { readKernelStartSeconds } from "../src/utils/kernel-start-time.js";

/** What `readProcessStartTime` derives from `ps` under its pinned zone and locale. */
function psStartSeconds(pid: number): number {
  const rendered = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
  }).toString().trim();
  return Math.floor(Date.parse(`${rendered} UTC`) / 1000);
}

/** Platforms where the start second is read in-process instead of from `ps`. */
const isNativePlatform = process.platform === "darwin" || process.platform === "linux";

describe("readKernelStartSeconds", () => {
  it.skipIf(!isNativePlatform)("equals the ps rendering for own, parent and foreign pids", () => {
    for (const pid of [process.pid, process.ppid, 1]) {
      expect(readKernelStartSeconds(pid)).toBe(psStartSeconds(pid));
    }
  });

  it.skipIf(process.platform !== "darwin")("defers to ps for a pid the kernel does not report", () => {
    expect(readKernelStartSeconds(999999)).toBeUndefined();
  });

  it.skipIf(process.platform !== "linux")("reports no start time for a pid /proc does not list", () => {
    expect(readKernelStartSeconds(999999)).toBeNull();
  });

  it.skipIf(isNativePlatform)("defers to ps on every other platform", () => {
    expect(readKernelStartSeconds(process.pid)).toBeUndefined();
  });
});
