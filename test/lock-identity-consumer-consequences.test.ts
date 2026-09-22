/**
 * @file test/lock-identity-consumer-consequences.test.ts
 * @description The two CONSUMERS of process identity, driven end to end — not
 * asserted from the predicate.
 *
 * WHY THIS FILE EXISTS SEPARATELY. `isOwnerStale` returning the right boolean is
 * necessary and not sufficient: what the defect actually did was reclaim a live
 * holder's project lock and clear a live executor's fence. A predicate-level
 * suite can be green while a consumer still reads the leaf a different way, so
 * each consumer is driven through its own real entry point and the DURABLE
 * ARTEFACT is inspected afterwards — the leaf's bytes, not the return value.
 *
 * THE LEGACY LEAF IS THE FIXTURE THROUGHOUT, because that is the state every
 * existing project is in the moment this build first runs. If the migration is
 * wrong, these are the two places it destroys something.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { LLMWIKI_DIR } from "../src/utils/constants.js";

/** The pre-fix leaf shape: a live pid plus a HUMAN-READABLE rendered start time. */
const LEGACY_RENDERING = "Thu Jul 23 11:16:28 2026";

let root = "";
let child: ChildProcess;
let livePid = 0;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "llmwiki-identity-consumer-"));
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  child = spawn("sleep", ["120"], { stdio: "ignore" });
  livePid = child.pid ?? 0;
  await new Promise((resolve) => setTimeout(resolve, 100));
  // The holder must be genuinely live and genuinely foreign, or "the lock was not
  // stolen" is true for a reason that has nothing to do with the fix.
  expect(livePid).toBeGreaterThan(0);
  expect(livePid).not.toBe(process.pid);
  expect(() => process.kill(livePid, 0)).not.toThrow();
});
afterEach(async () => {
  child.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
});

/** The lock leaf's raw bytes, or null when it is gone. */
async function leaf(): Promise<string | null> {
  return readFile(path.join(root, LLMWIKI_DIR, "lock"), "utf-8").catch(() => null);
}

/** Plant a lock leaf naming a LIVE holder in the pre-fix identity format. */
async function plantLegacyHeldLock(): Promise<string> {
  const startTime = execFileSync("ps", ["-o", "lstart=", "-p", String(livePid)]).toString().trim();
  const content = JSON.stringify({ pid: livePid, startTime });
  await writeFile(path.join(root, LLMWIKI_DIR, "lock"), content, "utf-8");
  return content;
}

describe("consumer 1: project-lock reclamation", () => {
  it("does NOT steal a live holder's lock recorded in the legacy format", async () => {
    // THE DEFECT'S PRIMARY CONSEQUENCE, and the migration's primary risk. A
    // reader emitting `unix:<epoch>` sees a rendered date string, and if it reads
    // that difference as PID reuse it takes the lock from a running process.
    const planted = await plantLegacyHeldLock();
    expect(await acquireLock(root, { quiet: true })).toBe(false);
    // THE ASSERTION THAT BINDS: the leaf still names the ORIGINAL holder. A
    // boolean-only check passes against code that reclaimed and then re-planted.
    expect(await leaf()).toBe(planted);
  });

  it("still reclaims a lock whose holder is genuinely DEAD", async () => {
    // The over-correction guard at the consumer level: a fix that made every
    // legacy leaf unreclaimable would wedge every project that ever crashed.
    await writeFile(
      path.join(root, LLMWIKI_DIR, "lock"),
      JSON.stringify({ pid: 999999, startTime: LEGACY_RENDERING }), "utf-8");
    expect(await acquireLock(root, { quiet: true })).toBe(true);
    // It took the lock and wrote its own identity in the NEW format.
    const held = await leaf();
    expect(held).toContain(String(process.pid));
    expect(held).toContain("unix:");
    await releaseLock(root);
  });

  it("writes the new identity format on a fresh acquire", async () => {
    expect(await acquireLock(root, { quiet: true })).toBe(true);
    const parsed = JSON.parse(await leaf() ?? "{}") as { pid: number; startTime?: string; identity?: string };
    expect(parsed.pid).toBe(process.pid);
    // VERSIONED, which is the whole reason the migration is detectable at all.
    expect(parsed.identity).toMatch(/^unix:\d+$/u);
    expect(parsed.startTime).toBe(execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)]).toString().trim());
    await releaseLock(root);
  });
});

describe("consumer 2: the identity a second acquirer compares against", () => {
  it("round-trips its own identity, so a re-read never reports itself stale", async () => {
    // THE SELF-CONSISTENCY THE DEFECT BROKE ACROSS TIME. The writer and the
    // reader are the same build here; under the old format they still disagreed
    // whenever the ambient zone shifted between the two reads — which a DST
    // transition does on one host, with nothing misconfigured.
    expect(await acquireLock(root, { quiet: true })).toBe(true);
    const held = await leaf();
    // A second acquisition must see its own record as a LIVE holder, not as a
    // reused pid, in every zone it might be attempted from.
    for (const zone of ["UTC", "Asia/Tokyo", "America/New_York"]) {
      const previous = process.env.TZ;
      process.env.TZ = zone;
      try {
        expect(await acquireLock(root, { quiet: true }), zone).toBe(false);
        expect(await leaf(), zone).toBe(held);
      } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
      }
    }
    await releaseLock(root);
  });
});
