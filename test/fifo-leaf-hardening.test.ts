/**
 * A FIFO planted at a hardened project leaf must be refused, never opened in a
 * way that blocks: O_NOFOLLOW alone does not stop a FIFO, and a blocked open
 * hangs the command (usually while it holds the project lock). Each case plants
 * a FIFO at one leaf and requires the real reader or writer to settle promptly
 * with its fail-closed result. Planted FIFOs are released after every test so a
 * regression that does block cannot wedge the test worker.
 */
import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyIntoCustody } from "../src/preparations/attempts/custody.js";
import { loadProfile } from "../src/profile/load.js";
import { loadBatch } from "../src/trust/journal.js";
import { readConfinedRaw } from "../src/utils/embeddings-store.js";
import { openGraphFileAppend, openGraphFileRead } from "../src/utils/jsonl-store.js";
import { acquireLock } from "../src/utils/lock.js";
import { NoFollowOpenError, openFileNoFollow } from "../src/utils/no-follow-open.js";
import { readPendingMarker } from "../src/utils/pending-embeddings.js";
import { timeStage } from "../src/utils/stage-timing.js";
import { readStateClassified } from "../src/utils/state.js";
import { PENDING_EMBEDDINGS_FILE, PROFILE_FILE, QUARANTINED_EMBEDDINGS_FILE, STATE_FILE } from "../src/utils/constants.js";
import { expectCLIExit, runCLI } from "./fixtures/run-cli.js";

const SETTLE_MS = 3000;
const planted: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  // Opening the FIFO read-write releases any open still blocked on it.
  for (const fifo of planted.splice(0)) {
    await open(fifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK).then(h => h.close(), () => {});
  }
});

/** A fresh project root with an empty `.llmwiki`. */
async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-fifo-"));
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  return root;
}

/** Plant a FIFO at `relative` under `root` and return its absolute path. */
async function plantFifo(root: string, relative: string): Promise<string> {
  const fifo = path.join(root, relative);
  await mkdir(path.dirname(fifo), { recursive: true });
  execFileSync("mkfifo", [fifo]);
  planted.push(fifo);
  return fifo;
}

/** Resolve with the operation's outcome, or report that it blocked. */
async function settle<T>(operation: Promise<T>): Promise<{ value?: T; error?: unknown } | "blocked"> {
  const timeout = new Promise<"blocked">(resolve => setTimeout(() => resolve("blocked"), SETTLE_MS));
  return Promise.race([operation.then(value => ({ value }), error => ({ error })), timeout]);
}

it("refuses a FIFO for reading and for appending instead of blocking", async () => {
  const fifo = await plantFifo(await project(), ".llmwiki/leaf");
  const read = await settle(openFileNoFollow(fifo, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW));
  expect(read).toEqual({ error: expect.any(NoFollowOpenError) });
  expect((read as { error: NoFollowOpenError }).error.reason).toBe("not-regular");
  const append = await settle(openFileNoFollow(fifo, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW));
  expect(append).not.toBe("blocked");
  expect(append).toHaveProperty("error");
});

it("still opens and reads a regular file", async () => {
  const root = await project();
  const file = path.join(root, ".llmwiki/leaf");
  await writeFile(file, "ok");
  const handle = await openFileNoFollow(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { expect(await handle.readFile("utf8")).toBe("ok"); } finally { await handle.close(); }
});

it.each([PENDING_EMBEDDINGS_FILE, QUARANTINED_EMBEDDINGS_FILE])("reports an embedding retry marker FIFO at %s as unavailable", async marker => {
  const root = await project();
  await plantFifo(root, marker);
  const file = marker === PENDING_EMBEDDINGS_FILE ? undefined : QUARANTINED_EMBEDDINGS_FILE;
  expect(await settle(readPendingMarker(root, file))).toEqual({ value: expect.objectContaining({ status: "unavailable" }) });
});

it("classifies a state.json FIFO as corrupt", async () => {
  const root = await project();
  await plantFifo(root, STATE_FILE);
  expect(await settle(readStateClassified(root))).toEqual({ value: expect.objectContaining({ status: "corrupt" }) });
});

it("does not block acquiring the project lock when the lock leaf is a FIFO", async () => {
  const root = await project();
  await plantFifo(root, ".llmwiki/lock");
  expect(await settle(acquireLock(root))).toEqual({ value: expect.any(Boolean) });
});

it("treats embedding-store, journal and profile FIFOs as unreadable", async () => {
  const root = await project();
  await plantFifo(root, ".llmwiki/embeddings.json");
  await plantFifo(root, ".llmwiki/journal/batch-1.json");
  await plantFifo(root, PROFILE_FILE);
  expect(await settle(readConfinedRaw(root))).toEqual({ value: null });
  expect(await settle(loadBatch(root, "batch-1"))).toEqual({ value: null });
  expect(await settle(loadProfile(root))).toHaveProperty("error");
});

it("refuses a graph store FIFO for reading and appending", async () => {
  const fifo = await plantFifo(await project(), "wiki/graph/relations.jsonl");
  const symlinkError = (message: string) => new Error(message);
  expect(await settle(openGraphFileRead(fifo, symlinkError))).toHaveProperty("error");
  expect(await settle(openGraphFileAppend(fifo, symlinkError))).toHaveProperty("error");
});

it("refuses a FIFO as a custody copy source", async () => {
  const root = await project();
  const fifo = await plantFifo(root, "output.bin");
  await mkdir(path.join(root, "custody"));
  expect(await settle(copyIntoCustody(fifo, path.join(root, "custody"), "0".repeat(64), 1024))).toEqual({ value: null });
});

// Regression guard: the timing sink already opened with O_NONBLOCK before this change.
it("skips a FIFO stage-timing sink without delaying the measured work", async () => {
  const root = await project();
  vi.stubEnv("LLMWIKI_STAGE_TIMING_FILE", await plantFifo(root, "timing.jsonl"));
  expect(await settle(timeStage("compile.finalize", async () => "done"))).toEqual({ value: "done" });
});

it("keeps `llmwiki status` responsive with a FIFO planted at the pending-embeddings marker", async () => {
  const root = await project();
  await plantFifo(root, PENDING_EMBEDDINGS_FILE);
  const run = await settle(runCLI(["status"], root, { LLMWIKI_EMBEDDINGS: "off", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" }));
  expect(run).not.toBe("blocked");
  expectCLIExit((run as { value: Awaited<ReturnType<typeof runCLI>> }).value, 0);
}, 20_000);
