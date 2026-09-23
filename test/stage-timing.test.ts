/**
 * Opt-in stage timing: off by default (no I/O, same result), on only for an
 * absolute log path, records exactly the fixed allowlisted fields, records a
 * failed stage without masking its error, and never lets a broken log path fail
 * the measured work.
 */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { timeStage } from "../src/utils/stage-timing.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh private directory for one test's log. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llmwiki-stage-timing-"));
  dirs.push(dir);
  return dir;
}

/** Parse every JSON line written to the log. */
async function records(file: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

it("does nothing but run the stage when the variable is unset or not absolute", async () => {
  const dir = await scratch();
  expect(await timeStage("compile.extraction", async () => "result")).toBe("result");
  vi.stubEnv("LLMWIKI_STAGE_TIMING_FILE", "relative/timing.jsonl");
  const previous = process.cwd();
  process.chdir(dir);
  try {
    expect(await timeStage("compile.extraction", async () => "result")).toBe("result");
  } finally {
    process.chdir(previous);
  }
  expect(await readdir(dir)).toEqual([]);
});

it("appends one record with exactly the allowlisted fields per stage", async () => {
  const file = path.join(await scratch(), "timing.jsonl");
  vi.stubEnv("LLMWIKI_STAGE_TIMING_FILE", file);
  expect(await timeStage("query.retrieval", async () => 1)).toBe(1);
  expect(await timeStage("query.answer", async () => 2)).toBe(2);
  const written = await records(file);
  expect(written.map((entry) => entry.stage)).toEqual(["query.retrieval", "query.answer"]);
  for (const entry of written) {
    expect(Object.keys(entry).sort()).toEqual(["ms", "ok", "pid", "stage", "v"]);
    expect(entry).toMatchObject({ v: 1, ok: true, pid: process.pid });
    expect(typeof entry.ms === "number" && entry.ms >= 0).toBe(true);
  }
});

it("records a failed stage and rethrows the original error", async () => {
  const file = path.join(await scratch(), "timing.jsonl");
  vi.stubEnv("LLMWIKI_STAGE_TIMING_FILE", file);
  const failure = new Error("stage failed");
  await expect(timeStage("compile.page-generation", async () => { throw failure; })).rejects.toBe(failure);
  expect(await records(file)).toEqual([expect.objectContaining({ stage: "compile.page-generation", ok: false })]);
});

it("never fails the measured work when the log cannot be written", async () => {
  const missingParent = path.join(await scratch(), "absent", "timing.jsonl");
  vi.stubEnv("LLMWIKI_STAGE_TIMING_FILE", missingParent);
  expect(await timeStage("compile.finalize", async () => "done")).toBe("done");
});

it.runIf(process.platform !== "win32")("returns and rethrows promptly when the log path is a FIFO nobody reads", async () => {
  const fifo = path.join(await scratch(), "timing.fifo");
  execFileSync("mkfifo", [fifo]);
  vi.stubEnv("LLMWIKI_STAGE_TIMING_FILE", fifo);
  expect(await timeStage("compile.detect-changes", async () => "done")).toBe("done");
  const failure = new Error("stage failed");
  await expect(timeStage("compile.extraction", async () => { throw failure; })).rejects.toBe(failure);
}, 5_000);
