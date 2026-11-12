/** Receipt publication uses real temporary files with injected filesystem failures.
 * Handled failures must not publish partial usage, leak pending files when cleanup
 * is available, or hide the original error behind close/removal failures.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, spyOn, type Mock } from "bun:test";
import { restoreEnv, stubEnv } from "./stubs.js";
import { recordUsage } from "../src/providers/usage.js";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";

/** The real `node:fs`, captured before the spies replace its exports. */
const actual = { ...fs };
const failing = ["writeFileSync", "fsyncSync", "closeSync", "renameSync", "rmSync"] as const;
const spies = Object.fromEntries(failing.map((name) => [name, spyOn(fs, name)])) as
  { [Name in (typeof failing)[number]]: Mock<(typeof fs)[Name]> };
const uuid = spyOn(crypto, "randomUUID").mockReturnValue(EVENT_ID);
afterAll(() => {
  for (const spy of [...Object.values(spies), uuid]) spy.mockRestore();
});

let directory: string;

beforeEach(async () => {
  for (const spy of Object.values(spies)) spy.mockClear();
  directory = await mkdtemp(path.join(tmpdir(), "receipt-publication-"));
  stubEnv("LLMWIKI_USAGE_DIRECTORY", directory);
  stubEnv("LLMWIKI_USAGE_EXECUTION_ID", "execution");
});
afterEach(async () => {
  restoreEnv();
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
  expect(spies.closeSync).toHaveBeenCalledTimes(1);
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
    if (stage === "closeSync") {
      spies.closeSync.mockImplementationOnce((fd) => { actual.closeSync(fd); throw failure; });
    } else {
      spies[stage].mockImplementationOnce(() => { throw failure; });
    }
    await expectCleanFailure(failure);
  },
);

it("preserves the write failure when closing the descriptor also fails", async () => {
  const failure = new Error("write failed");
  spies.writeFileSync.mockImplementationOnce(() => { throw failure; });
  spies.closeSync.mockImplementationOnce((fd) => { actual.closeSync(fd); throw new Error("close failed"); });
  await expectCleanFailure(failure);
});

it("preserves the publication failure when pending-file removal also fails", async () => {
  const failure = new Error("flush failed");
  spies.fsyncSync.mockImplementationOnce(() => { throw failure; });
  spies.rmSync.mockImplementationOnce(() => { throw new Error("remove failed"); });
  expect(publish).toThrowError(expect.objectContaining({ cause: failure, nonRetryable: true }));
  expect(spies.rmSync).toHaveBeenCalledTimes(1);
  expect(await readdir(directory)).toEqual([`${EVENT_ID}.pending`]);
});

it("leaves another writer's pending file intact when exclusive creation fails", async () => {
  const pending = path.join(directory, `${EVENT_ID}.pending`);
  await writeFile(pending, "other writer");
  expect(publish).toThrowError(expect.objectContaining({ nonRetryable: true }));
  expect(spies.rmSync).not.toHaveBeenCalled();
  expect(spies.closeSync).not.toHaveBeenCalled();
  expect(await readFile(pending, "utf8")).toBe("other writer");
});
