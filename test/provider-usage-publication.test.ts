/** Receipt publication uses real temporary files with injected filesystem failures.
 * Handled failures must not publish partial usage, leak pending files when cleanup
 * is available, or hide the original error behind close/removal failures.
 */
import * as fs from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recordUsage } from "../src/providers/usage.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), fsyncSync: vi.fn(actual.fsyncSync),
    closeSync: vi.fn(actual.closeSync), renameSync: vi.fn(actual.renameSync), rmSync: vi.fn(actual.rmSync) };
});
vi.mock("node:crypto", () => ({ randomUUID: () => "00000000-0000-4000-8000-000000000001" }));

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
let directory: string;

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(path.join(tmpdir(), "receipt-publication-"));
  vi.stubEnv("LLMWIKI_USAGE_DIRECTORY", directory);
  vi.stubEnv("LLMWIKI_USAGE_EXECUTION_ID", "execution");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

/** Exercise the public receipt writer without making a model request. */
function publish(): void {
  recordUsage(() => ({ provider: "openai", model: "model", operation: "complete",
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } }));
}

/** Verify a handled failure closes once and removes its unpublished file. */
async function expectCleanFailure(failure: Error): Promise<void> {
  expect(publish).toThrowError(expect.objectContaining({ cause: failure, nonRetryable: true }));
  expect(fs.closeSync).toHaveBeenCalledTimes(1);
  expect(await readdir(directory)).toEqual([]);
}

it("publishes one complete receipt without a pending file", async () => {
  publish();
  expect(await readdir(directory)).toEqual([`${EVENT_ID}.json`]);
  expect(JSON.parse(await readFile(path.join(directory, `${EVENT_ID}.json`), "utf8")))
    .toMatchObject({ eventId: EVENT_ID, inputTokens: 100, outputTokens: 20, usageComplete: true });
});

it.each(["writeFileSync", "fsyncSync", "closeSync", "renameSync"] as const)(
  "cleans up handled %s failures and preserves the publication error", async (stage) => {
    const failure = new Error(`${stage} failed`);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    if (stage === "closeSync") {
      vi.mocked(fs.closeSync).mockImplementationOnce((fd) => { actual.closeSync(fd); throw failure; });
    } else {
      vi.mocked(fs[stage]).mockImplementationOnce(() => { throw failure; });
    }
    await expectCleanFailure(failure);
  },
);

it("preserves the write failure when closing the descriptor also fails", async () => {
  const failure = new Error("write failed");
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw failure; });
  vi.mocked(fs.closeSync).mockImplementationOnce((fd) => { actual.closeSync(fd); throw new Error("close failed"); });
  await expectCleanFailure(failure);
});

it("preserves the publication failure when pending-file removal also fails", async () => {
  const failure = new Error("flush failed");
  vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw failure; });
  vi.mocked(fs.rmSync).mockImplementationOnce(() => { throw new Error("remove failed"); });
  expect(publish).toThrowError(expect.objectContaining({ cause: failure, nonRetryable: true }));
  expect(fs.rmSync).toHaveBeenCalledTimes(1);
  expect(await readdir(directory)).toEqual([`${EVENT_ID}.pending`]);
});

it("leaves another writer's pending file intact when exclusive creation fails", async () => {
  const pending = path.join(directory, `${EVENT_ID}.pending`);
  await writeFile(pending, "other writer");
  expect(publish).toThrowError(expect.objectContaining({ nonRetryable: true }));
  expect(fs.rmSync).not.toHaveBeenCalled();
  expect(fs.closeSync).not.toHaveBeenCalled();
  expect(await readFile(pending, "utf8")).toBe("other writer");
});
