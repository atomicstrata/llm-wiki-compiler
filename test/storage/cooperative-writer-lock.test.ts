/**
 * @file test/storage/cooperative-writer-lock.test.ts
 * @description The cooperative-writer lock as ONE body over a gate double:
 * `withCooperativeWriterLockWith(CooperativeWriterGate)`. Every case is
 * deterministic: the lock is an in-memory mutex and each interleaving is
 * driven by explicit signals, never by a sleep or a race.
 *
 * Shown: an ordinary project's writer takes the raw lock, looks again under
 * it and writes; a registered project's takes the gated lock; registration
 * that appears while the writer waits sends it to the gated lock with nothing
 * written; a pending transition refuses before any effect; the lock is
 * released on every exit; and the two first-opt-in orders (writer before
 * transition, transition before writer) both serialize. A lock that stays
 * busy refuses with a project-busy error before any write, and only the
 * lock's own busy timeout is reworded: a gate refusal and a writer's failure
 * keep their own error. The last suite binds that through the public SDK on
 * a real directory whose lock this test holds for the lock's bounded wait.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { ProjectBusyError, withCooperativeWriterLockWith, type CooperativeWriterGate } from "../../src/operation-bundles/registered-project-lock.js";
import { createWikiCore } from "../../src/sdk/core.js";
import { acquireLock, LockBusyError, releaseLock } from "../../src/utils/lock.js";

/** A promise and the function that settles it: one explicit signal between two actors. */
function signal(): { reached: Promise<void>; fire: () => void } {
  let fire = (): void => {};
  const reached = new Promise<void>((resolve) => { fire = resolve; });
  return { reached, fire };
}

/** An in-memory, FIFO project lock. */
class MemoryLock {
  private held = false;
  private readonly waiters: Array<() => void> = [];
  async acquire(): Promise<void> {
    if (!this.held) { this.held = true; return; }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next(); else this.held = false;
  }
}

/** The state one case's gate double reads: the registration answers, in order, and an optional gate refusal. */
interface Scenario { registered: boolean[]; refusal?: Error; busy?: Error; lock?: MemoryLock }

/** A gate double that logs every call. `registered` answers are consumed in order; the last one repeats. */
function gateOf(log: string[], scenario: Scenario): CooperativeWriterGate {
  const lock = scenario.lock ?? new MemoryLock();
  let look = 0;
  return {
    registered: async () => { log.push("registered?"); return scenario.registered[Math.min(look++, scenario.registered.length - 1)]!; },
    acquire: async () => { await lock.acquire(); log.push("acquire-gated"); if (scenario.refusal) { lock.release(); throw scenario.refusal; } },
    acquireUnregistered: async () => { if (scenario.busy) throw scenario.busy; await lock.acquire(); log.push("acquire-raw"); },
    release: async () => { log.push("release"); lock.release(); },
  };
}

/** Run one writer over a scenario; returns its outcome (or error message) and the call log. */
async function run(scenario: Scenario, write: () => Promise<string> = async () => "ok"): Promise<[string, string[]]> {
  const log: string[] = [];
  const outcome = await withCooperativeWriterLockWith(gateOf(log, scenario), "source save", async () => { log.push("write"); return write(); }).catch((error: Error) => error.message);
  return [outcome, log];
}

describe("the cooperative-writer lock: one body", () => {
  it("an ordinary project writes under the raw lock, after looking again under it", async () => {
    expect(await run({ registered: [false] })).toEqual(["ok", ["registered?", "acquire-raw", "registered?", "write", "release"]]);
  });

  it("a registered project writes under the gated lock", async () => {
    expect(await run({ registered: [true] })).toEqual(["ok", ["registered?", "acquire-gated", "write", "release"]]);
  });

  it("registration that appears during admission writes nothing under the raw lock and starts again under the gate", async () => {
    expect(await run({ registered: [false, true] })).toEqual(["ok", ["registered?", "acquire-raw", "registered?", "release", "acquire-gated", "write", "release"]]);
  });

  it("a pending transition refuses before any effect, on both paths", async () => {
    const refusal = new Error("scale transition unfinished");
    expect(await run({ registered: [true], refusal })).toEqual(["scale transition unfinished", ["registered?", "acquire-gated"]]);
    expect(await run({ registered: [false, true], refusal })).toEqual(["scale transition unfinished", ["registered?", "acquire-raw", "registered?", "release", "acquire-gated"]]);
  });

  it("releases the lock when the writer fails, and takes none when the raw lock is busy", async () => {
    expect(await run({ registered: [false] }, async () => { throw new Error("disk full"); })).toEqual(["disk full", ["registered?", "acquire-raw", "registered?", "write", "release"]]);
    expect(await run({ registered: [true] }, async () => { throw new Error("disk full"); })).toEqual(["disk full", ["registered?", "acquire-gated", "write", "release"]]);
    expect(await run({ registered: [false], busy: new Error("busy") })).toEqual(["busy", ["registered?"]]);
  });
});

describe("the first opt-in serializes with a cooperative writer", () => {
  it("writer before transition: the transition waits until the write has finished", async () => {
    const lock = new MemoryLock();
    const order: string[] = [];
    const writing = signal();
    const mayFinish = signal();
    const writer = withCooperativeWriterLockWith(gateOf([], { registered: [false], lock }), "source save", async () => {
      order.push("write-start"); writing.fire(); await mayFinish.reached; order.push("write-end");
    });
    await writing.reached;
    const transition = lock.acquire().then(() => { order.push("transition"); lock.release(); });
    mayFinish.fire();
    await Promise.all([writer, transition]);
    expect(order).toEqual(["write-start", "write-end", "transition"]);
  });

  it("transition before writer: the writer waits, then is refused under the gate with nothing written", async () => {
    const lock = new MemoryLock();
    const log: string[] = [];
    const state = { registered: false };
    await lock.acquire(); // the transition holds the project lock; the writer has not looked yet
    const gate: CooperativeWriterGate = {
      ...gateOf(log, { registered: [false], refusal: new Error("scale transition unfinished"), lock }),
      registered: async () => { log.push(`registered? ${state.registered}`); return state.registered; },
    };
    const writer = withCooperativeWriterLockWith(gate, "source save", async () => { log.push("write"); }).catch((error: Error) => error.message);
    await Promise.resolve(); // the writer has looked (unregistered) and is queued behind the transition
    state.registered = true; // the transition creates its record while it holds the lock, and parks
    lock.release();
    expect(await writer).toBe("scale transition unfinished");
    expect(log).toEqual(["registered? false", "acquire-raw", "registered? true", "release", "acquire-gated"]);
  });
});


describe("a busy project lock refuses before any write", () => {
  it("rewords only the lock's busy timeout, keeps it as the cause, and never runs the writer", async () => {
    for (const registered of [[false], [true]]) {
      const log: string[] = [];
      const gate = gateOf(log, { registered });
      const busy = new LockBusyError(5_000);
      const error = await withCooperativeWriterLockWith({ ...gate, acquire: async () => { throw busy; }, acquireUnregistered: async () => { throw busy; } },
        "schema init", async () => { log.push("write"); }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProjectBusyError);
      expect(error).toBeInstanceOf(LockBusyError);
      expect((error as ProjectBusyError).cause).toBe(busy);
      expect((error as Error).message).toMatch(/project is busy.*schema init did not start and changed no source or schema file.*Retry/u);
      expect((error as Error).message).not.toMatch(/relation store/u);
      expect(log).toEqual(["registered?"]);
    }
  });

  it("leaves a gate refusal and a writer's own failure exactly as they were", async () => {
    const refusal = new Error("scale transition unfinished");
    expect(await run({ registered: [true], refusal })).toEqual(["scale transition unfinished", ["registered?", "acquire-gated"]]);
    const failure = await withCooperativeWriterLockWith(gateOf([], { registered: [false] }), "source save", async () => { throw new LockBusyError(1); }).catch((caught: unknown) => caught);
    expect(failure).not.toBeInstanceOf(ProjectBusyError);
  });
});

describe("the public source writers refuse a busy ordinary project", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "llmwiki-busy-")); });
  afterEach(async () => { await releaseLock(root).catch(() => undefined); await rm(root, { recursive: true, force: true }); });

  it("ingest and source delete wait the lock's bounded time, then refuse with nothing written or removed", async () => {
    const core = createWikiCore({ root });
    const kept = await core.ingestText({ title: "Kept Note", text: "Kept.\n" });
    expect(await acquireLock(root, { quiet: true })).toBe(true); // another operation holds the project lock
    await expect(core.ingestText({ title: "Late Note", text: "Late.\n" })).rejects.toMatchObject({ name: "ProjectBusyError", operation: "source save" });
    await expect(core.deleteSource(kept.filename)).rejects.toMatchObject({ name: "ProjectBusyError", operation: "source delete" });
    expect(await readdir(path.join(root, "sources"))).toEqual([kept.filename]);
    await releaseLock(root);
    expect(await core.deleteSource(kept.filename)).toBe(true);
  }, 30_000);
});
