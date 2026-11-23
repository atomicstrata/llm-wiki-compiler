/**
 * @file test/scale-measure/disk-receipt-probe.ts
 * @description Isolated fake child and disk failure for the receipt test.
 */

import { writeFile } from "node:fs/promises";
import { mock } from "bun:test";

const [out, base, exitCode] = process.argv.slice(2);
if (!out || !base || !exitCode) throw new Error("usage: disk-receipt-probe <out> <base> <exit-code>");

mock.module("../helpers-child-process.js", () => ({
  bundleChild: async () => "fake-child",
  startChild: () => ({}),
  childEnd: async () => ({ code: Number(exitCode), signal: null, json: { mode: "build", name: "init", completed: true }, stdout: "", stderr: "" }),
}));
mock.module("./environment.js", () => ({
  environment: () => ({ head: "fixture" }),
  diskBytes: async () => { throw new Error("disk-observation-failed"); },
  resultsRecorder: (file: string, results: { entries: unknown[] }) => async (entry: unknown) => {
    results.entries.push(entry);
    await writeFile(file, JSON.stringify(results));
  },
}));

const { runMeasurements } = await import("./run.js");
try {
  await runMeasurements(out, [["indexed", 1]], base, "build");
  throw new Error("measurement unexpectedly succeeded");
} catch (error) {
  if (!/^measurement (child|disk evidence) failed:/u.test(String((error as Error).message))) throw error;
}
