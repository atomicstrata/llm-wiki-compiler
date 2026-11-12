/**
 * @file test/storage/connector-rate-legacy.test.ts
 * @description The connector request-interval floor through its ROOT function,
 * `enforceRequestInterval`, on real files. The existing connector tests reach
 * it only through a whole connector run and assert a result kind or whether
 * the stamp file exists; none names a reason or reads the stamp's bytes. This
 * file pins five whole outcomes with literal reasons and literal stamp bytes.
 * It says what running the stamp over storage bindings must not change, so it
 * is run byte for byte against the source both before and after.
 *
 * R1 runs on a bare temp root, because a non-positive interval returns before
 * the lock and before any I/O. R2 to R5 run on the newsroom fixture project,
 * the project the existing connector tests already take the project lock on.
 *
 * NOT covered here, and unchanged: that the lock is released when the stamp
 * read rejects, and that a blocked recovery gate rejects before the stamp is
 * touched. Neither can be reached without replacing the lock.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import type { ConnectorRuntimeConfig } from "../../src/connectors/config.js";
import { enforceRequestInterval } from "../../src/connectors/rate-limit.js";
import { acquireLock, releaseLock } from "../../src/utils/lock.js";
import { buildNewsroomProject } from "../fixtures/newsroom-profile.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const project = useTempRoot();
const T = 1_800_000_000_000;
const REFUSED = { kind: "refused", reason: "connector minimum request interval has not elapsed" };

/** The stamp file of the `fixture` connector in the current temp project. */
const stampFile = (): string => path.join(project.dir, ".llmwiki", "connectors", "fixture.last-fetch.json");
const stampBytes = (): Promise<string> => readFile(stampFile(), "utf8");
const floorOf = (minRequestIntervalMs: number): ConnectorRuntimeConfig => ({ minRequestIntervalMs, allowedHosts: [] });

/** Apply a floor of `minMs` for the `fixture` connector with the clock fixed at `atMs`. */
const enforceAt = (atMs: number, minMs = 1_000) =>
  enforceRequestInterval(project.dir, "fixture", floorOf(minMs), () => new Date(atMs));

/** Put `text` where the stamp lives, as an earlier run or an operator might have left it. */
async function plantStamp(text: string): Promise<void> {
  await mkdir(path.dirname(stampFile()), { recursive: true });
  await writeFile(stampFile(), text);
}

describe("the connector request-interval floor through its root function, as it behaves today", () => {
  it("R1 returns null for a zero or negative interval without creating the private directory", async () => {
    expect(await enforceAt(T, 0)).toBeNull();
    expect(await enforceAt(T, -1)).toBeNull();
    expect(existsSync(path.join(project.dir, ".llmwiki"))).toBe(false);
  });

  it("R2 writes the first stamp as one JSON line and leaves the project lock free", async () => {
    await buildNewsroomProject(project.dir);
    expect(await enforceAt(T)).toBeNull();
    expect(await stampBytes()).toBe('{"atMs":1800000000000}\n');
    expect(await acquireLock(project.dir, { quiet: true })).toBe(true);
    await releaseLock(project.dir);
  });

  it("R3 refuses inside the interval without rewriting the stamp, and allows exactly at it", async () => {
    await buildNewsroomProject(project.dir);
    expect(await enforceAt(T)).toBeNull();
    expect(await enforceAt(T + 500)).toEqual(REFUSED);
    expect(await stampBytes()).toBe('{"atMs":1800000000000}\n');
    expect(await enforceAt(T + 1_000)).toBeNull();
    expect(await stampBytes()).toBe('{"atMs":1800000001000}\n');
  });

  it("R4 fails closed on a corrupt stamp and on an oversized stamp, leaving each untouched", async () => {
    await buildNewsroomProject(project.dir);
    await plantStamp('{"atMs":"soon"}');
    expect(await enforceAt(T)).toEqual({ kind: "unavailable", reason: "connector rate state corrupt" });
    expect(await stampBytes()).toBe('{"atMs":"soon"}');
    const oversized = `{"atMs":1,"pad":"${"x".repeat(600)}"}`;
    await plantStamp(oversized);
    expect(await enforceAt(T)).toEqual({ kind: "unavailable", reason: "connector rate state unavailable" });
    expect(await stampBytes()).toBe(oversized);
  });

  it("R5 reports the rate state as locked while the project lock is held, and does not release the holder's lock", async () => {
    await buildNewsroomProject(project.dir);
    expect(await acquireLock(project.dir, { quiet: true })).toBe(true);
    try {
      expect(await enforceAt(T)).toEqual({ kind: "unavailable", reason: "connector rate state locked" });
      expect(existsSync(stampFile())).toBe(false);
      expect(await acquireLock(project.dir, { quiet: true })).toBe(false);
    } finally {
      await releaseLock(project.dir);
    }
  });
});
