/**
 * Durable batch ownership and write-ahead boundaries, independently of provider
 * behavior. Invalid storage must never allow collateral page bytes to change.
 */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { readFile, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { openReviewEmbeddingIntent } from "../src/commands/review-embedding-intent.js";
import { applyCompilePageWritesWithIdsLocked } from "../src/compiler/compile-write-ids.js";
import { acquireLockBlocking, releaseLock } from "../src/utils/lock.js";
import { GENERATED_PAGE_MAX_CHARS } from "../src/utils/constants.js";
import { stageBatchCandidate } from "./fixtures/review-batch.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const ctx = useTempRoot();
const INTENT_FILE = ".llmwiki/review-embedding-intent.json";
const VALID_BODY = "---\ntitle: Valid\n---\nNew body.\n";
beforeEach(() => acquireLockBlocking(ctx.dir));
afterEach(() => releaseLock(ctx.dir));

it("recovers a subset's shared work while retaining an unrelated interrupted batch", async () => {
  const a = await stageBatchCandidate(ctx.dir, "alpha");
  const b = await stageBatchCandidate(ctx.dir, "beta");
  const c = await stageBatchCandidate(ctx.dir, "other");
  await (await openReviewEmbeddingIntent(ctx.dir, [a, b])).record(["concepts/shared"]);
  await (await openReviewEmbeddingIntent(ctx.dir, [c])).record(["concepts/unrelated"]);
  const retry = await openReviewEmbeddingIntent(ctx.dir, [b]);
  expect([...retry.pageIds]).toEqual(["concepts/shared"]);
  await retry.clear();
  expect([...(await openReviewEmbeddingIntent(ctx.dir, [a])).pageIds]).toEqual([]);
  expect([...(await openReviewEmbeddingIntent(ctx.dir, [c])).pageIds]).toEqual(["concepts/unrelated"]);
});

it("does not attribute an older snapshot's work to an edited candidate", async () => {
  const candidate = await stageBatchCandidate(ctx.dir, "alpha");
  await (await openReviewEmbeddingIntent(ctx.dir, [candidate])).record(["concepts/old"]);
  const edited = { ...candidate, body: `${candidate.body}\nEdited.` };
  expect([...(await openReviewEmbeddingIntent(ctx.dir, [edited])).pageIds]).toEqual([]);
  expect([...(await openReviewEmbeddingIntent(ctx.dir, [candidate])).pageIds]).toEqual(["concepts/old"]);
});

it.each(["{malformed", '{"schemaVersion":2,"entries":[]}', "x".repeat(1024 * 1024 + 1)])(
  "fails closed on corrupt or oversized intent storage (%#)", async body => {
    await writeFile(path.join(ctx.dir, INTENT_FILE), body);
    await expect(openReviewEmbeddingIntent(ctx.dir, [])).rejects.toThrow();
    expect(await readFile(path.join(ctx.dir, INTENT_FILE), "utf8")).toBe(body);
  },
);

it("refuses a symlink leaf without reading or overwriting its target", async () => {
  const target = path.join(ctx.dir, "sentinel.json");
  await writeFile(target, "untouched");
  await symlink(target, path.join(ctx.dir, INTENT_FILE));
  await expect(openReviewEmbeddingIntent(ctx.dir, [])).rejects.toThrow("unavailable");
  expect(await readFile(target, "utf8")).toBe("untouched");
});

it("retains the last durable record when additional intent would exceed the byte cap", async () => {
  const candidate = await stageBatchCandidate(ctx.dir, "alpha");
  const intent = await openReviewEmbeddingIntent(ctx.dir, [candidate]);
  await intent.record(["concepts/first"]);
  const before = await readFile(path.join(ctx.dir, INTENT_FILE), "utf8");
  await expect(intent.record([`concepts/${"x".repeat(1024 * 1024)}`])).rejects.toThrow("exceeds 1 MiB");
  expect(await readFile(path.join(ctx.dir, INTENT_FILE), "utf8")).toBe(before);
});

it("records only floor-approved IDs while their old page bytes are still intact", async () => {
  const page = path.join(ctx.dir, "wiki/concepts/valid.md");
  await writeFile(page, "original");
  const before = vi.fn(async (ids: string[]) => {
    expect(ids).toEqual(["concepts/valid"]);
    expect(await readFile(page, "utf8")).toBe("original");
  });
  const ids = await applyCompilePageWritesWithIdsLocked(ctx.dir, [
    { namespace: "concepts", slug: "valid", body: VALID_BODY },
    { namespace: "concepts", slug: "huge", body: "x".repeat(GENERATED_PAGE_MAX_CHARS + 1) },
  ], before);
  expect(ids).toEqual(["concepts/valid"]);
  expect(before).toHaveBeenCalledOnce();
  expect(await readFile(page, "utf8")).toBe(VALID_BODY);
});

it("does not write page bytes when persisting their retry intent fails", async () => {
  const page = path.join(ctx.dir, "wiki/concepts/valid.md");
  await writeFile(page, "original");
  const persist = async () => { throw new Error("intent storage fault"); };
  await expect(applyCompilePageWritesWithIdsLocked(ctx.dir, [
    { namespace: "concepts", slug: "valid", body: VALID_BODY },
  ], persist)).rejects.toThrow("intent storage fault");
  expect(await readFile(page, "utf8")).toBe("original");
});
