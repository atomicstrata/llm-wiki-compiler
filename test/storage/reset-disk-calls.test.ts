/**
 * @file test/storage/reset-disk-calls.test.ts
 * @description `llmwiki state reset` through its REAL functions, on real files:
 * the backup-and-remove of `state.json`, the per-scope deletion plan, and the
 * execution of a plan. The file states behaviour that moving the seven direct
 * disk calls of `state-reset.ts` and `reset-plan.ts` behind `src/storage/` must
 * not change, so it is run byte for byte against the source both before and
 * after that move. Nine cases assert outcomes; only A1 asserts call lists.
 *
 * THIS COMMAND DESTROYS FILES. Every destructive call goes through
 * {@link ownedRoot}, which proves the working directory is this fixture's own
 * temp project before anything runs, and nothing is set up or removed anywhere
 * else.
 *
 * The project lock is replaced by a stand-in (`acquireMutationLock` resolves
 * true, `releaseLock` does nothing), so no case depends on lock or recovery
 * state; the real lock on this path is covered by the built-CLI tests. One
 * `lstat` on one named path can be made to reject. Setup and checks use the
 * real, unwrapped functions.
 *
 * SEVERAL CASES RECORD INCUMBENT BEHAVIOUR THAT IS KEPT ON PURPOSE AND NOT
 * ENDORSED: a link at `state.json.bak` is refused although the code comment
 * says it is allowed (B2); any failure looking that path up reads as "safe to
 * create" (B3); a linked `state.json` has its link renamed, not its target
 * (B4); a linked scope root is planned as its real target (P2); a failed
 * lookup of a scope root plans nothing (P3).
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";

/** `calls` are [function name, ...arguments] noted while `on`; `fault` rejects one `lstat` on one path. */
const io = (() => ({
  on: false,
  calls: [] as unknown[][],
  fault: null as null | { at: string; error: Error },
}))();

/**
 * The suite's `fs` tapper (`fs-taps.ts`): each tapped call is noted with its arguments while `on`, and
 * the one faulted `lstat` path rejects with the fault instead of reaching the real function. It is built
 * at top level so the mock factories below stay synchronous: Bun runs a factory eagerly, and an `await`
 * inside one never resumes, hanging the file at load.
 */
const { fsTapper } = await import("./fs-taps.js");
const tap = fsTapper({
  note: (name, args) => { if (io.on) io.calls.push([name, ...args]); },
  answer: (name, args) => (name === "lstat" && io.fault !== null && io.fault.at === args[0] ? Promise.reject(io.fault.error) : undefined),
});

// Snapshot real modules before mock.module replaces them for this file.
const realFsPromises = { ...(await import("node:fs/promises")) };

// Both spellings of each module: `state-reset.ts` uses the bare names before the move, `reset-plan.ts` and storage the `node:` ones.
const realFs = { ...(await import("fs")) };

vi.mock("fs", () => tap(realFs as typeof import("fs"), ["existsSync"]));
vi.mock("node:fs", () => tap(realFs as typeof import("node:fs"), ["existsSync"]));
vi.mock("fs/promises", () => tap(realFsPromises as typeof import("fs/promises"), ["lstat", "rename", "readdir"]));
vi.mock("node:fs/promises", () => tap(realFsPromises as typeof import("node:fs/promises"), ["lstat", "rename", "readdir"]));

import { executeReset, planReset, type ResetPlanV1 } from "../../src/commands/reset-plan.js";
import { stateResetCommand } from "../../src/commands/state-reset.js";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import { STATE_FILE } from "../../src/utils/constants.js";
import * as lock from "../../src/utils/lock.js";
import * as output from "../../src/utils/output.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const fs = realFsPromises as typeof import("node:fs/promises");
const STATE_BYTES = "\u0000not json { at all";
const ctx = useTempRoot();
let statuses: string[] = [];
let lockEvents: string[] = [];
let exitCodeBefore: typeof process.exitCode;

/**
 * The fixture's own project root, PROVED before any destructive call: the
 * fixture directory is set, is named like this fixture's temp projects, and is
 * the process working directory. Throws otherwise.
 */
async function ownedRoot(): Promise<string> {
  if (ctx.dir === "" || !path.basename(ctx.dir).startsWith("llmwiki-test-")) throw new Error(`not a fixture root: "${ctx.dir}"`);
  const real = await fs.realpath(ctx.dir);
  if (process.cwd() !== real) throw new Error(`working directory ${process.cwd()} is not the fixture root ${real}`);
  return real;
}

const inRoot = (...parts: string[]): string => path.join(process.cwd(), ...parts);
const statePath = (): string => inRoot(STATE_FILE);
const bakPath = (): string => `${statePath()}.bak`;
const present = (file: string): Promise<boolean> => fs.lstat(file).then(() => true, () => false);
const printed = (text: string): boolean => statuses.some((line) => line.includes(text));

/** Write `text` at a path under the project root, creating its directory. */
async function put(relative: string, text: string): Promise<string> {
  const file = inRoot(relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf-8");
  return file;
}

/** Apply `state reset --yes` to the proved fixture root. */
async function resetYes(): Promise<void> {
  await ownedRoot();
  await stateResetCommand({ yes: true });
}

/** Execute a plan against the proved fixture root. */
async function execute(plan: ResetPlanV1): Promise<Awaited<ReturnType<typeof executeReset>>> {
  return executeReset(await ownedRoot(), plan.scope, plan);
}

/** Make the next `lstat` of exactly `at` reject with an `EACCES` error. */
function failLookup(at: string): void {
  io.fault = { at, error: Object.assign(new Error("injected EACCES"), { code: "EACCES" }) };
}

/** Run `work` with call recording on. */
async function recording<T>(work: () => Promise<T>): Promise<T> {
  io.calls = [];
  io.on = true;
  try {
    return await work();
  } finally {
    io.on = false;
  }
}

beforeEach(() => {
  Object.assign(io, { on: false, calls: [], fault: null });
  statuses = [];
  lockEvents = [];
  exitCodeBefore = process.exitCode;
  vi.spyOn(output, "status").mockImplementation((icon: string, message: string) => { statuses.push(`${icon} ${message}`); });
  vi.spyOn(lockGate, "acquireMutationLock").mockImplementation(async () => {
    lockEvents.push(`acquired, state present: ${await present(statePath())}`);
    return true;
  });
  vi.spyOn(lock, "releaseLock").mockImplementation(async () => {
    lockEvents.push(`released, state present: ${await present(statePath())}`);
  });
});
afterEach(() => { process.exitCode = exitCodeBefore; });

describe("state reset: the state file and its backup", () => {
  it("D1 dry run reports no state file, or prints the plan, and changes nothing", async () => {
    await stateResetCommand();
    expect(printed("No state file to reset.")).toBe(true);
    await put(STATE_FILE, STATE_BYTES);
    await stateResetCommand();
    expect(printed(`Will back up ${STATE_FILE} to ${STATE_FILE}.bak and remove it`)).toBe(true);
    expect(await fs.readFile(statePath(), "utf-8")).toBe(STATE_BYTES);
    expect(await present(bakPath())).toBe(false);
    expect(lockEvents).toEqual([]);
  });

  it("B1 moves the raw bytes over a prior regular backup, between taking and releasing the lock", async () => {
    await put(STATE_FILE, STATE_BYTES);
    await put(`${STATE_FILE}.bak`, "old backup");
    await resetYes();
    expect(await fs.readFile(bakPath(), "utf-8")).toBe(STATE_BYTES);
    expect(await present(statePath())).toBe(false);
    expect(lockEvents).toEqual(["acquired, state present: true", "released, state present: false"]);
    expect(process.exitCode).toBe(exitCodeBefore);
  });

  it("B2 refuses a link at the backup path and leaves the state file alone (incumbent, kept, not endorsed)", async () => {
    await put(STATE_FILE, STATE_BYTES);
    await fs.symlink(await put("keep.txt", "kept"), bakPath());
    await resetYes();
    expect(process.exitCode).toBe(1);
    expect(printed("exists and is not a regular file")).toBe(true);
    expect(await fs.readFile(statePath(), "utf-8")).toBe(STATE_BYTES);
    expect((await fs.lstat(bakPath())).isSymbolicLink()).toBe(true);
  });

  it("B3 treats a failed lookup of the backup path as safe and backs up over the link (incumbent, kept, not endorsed)", async () => {
    await put(STATE_FILE, STATE_BYTES);
    await fs.symlink(await put("keep.txt", "kept"), bakPath());
    failLookup(bakPath());
    await resetYes();
    expect(process.exitCode).toBe(exitCodeBefore);
    expect(await present(statePath())).toBe(false);
    expect(await fs.readFile(bakPath(), "utf-8")).toBe(STATE_BYTES);
    expect(await fs.readFile(inRoot("keep.txt"), "utf-8")).toBe("kept");
  });

  it("B4 renames the link itself when state.json is a link to a file in the project (incumbent, kept)", async () => {
    const target = await put(".llmwiki/real-state.json", STATE_BYTES);
    await fs.symlink(target, statePath());
    await resetYes();
    expect((await fs.lstat(bakPath())).isSymbolicLink()).toBe(true);
    expect(await present(statePath())).toBe(false);
    expect(await fs.readFile(target, "utf-8")).toBe(STATE_BYTES);
  });
});

describe("state reset: planning and executing a scope", () => {
  it("P1 plans every nested regular file, and no directory and no link to a file", async () => {
    await put("wiki/top.md", "top");
    await put("wiki/concepts/a.md", "a");
    await put("wiki/concepts/deep/b.md", "b");
    await fs.symlink(inRoot("wiki/top.md"), inRoot("wiki/concepts/link.md"));
    const plan = await planReset(await ownedRoot(), "wiki");
    expect(plan).toEqual({ status: "planned", scope: "wiki", files: ["wiki/concepts/a.md", "wiki/concepts/deep/b.md", "wiki/top.md"] });
  });

  it("P2 plans a scope root that is a link as its real target's path (incumbent, kept)", async () => {
    await fs.symlink(await put("notes.md", "notes"), inRoot("log.md"));
    expect(await planReset(await ownedRoot(), "log")).toEqual({ status: "planned", scope: "log", files: ["notes.md"] });
  });

  it("P3 plans nothing for a scope whose root cannot be looked up (incumbent, kept)", async () => {
    await put("raw/x.md", "x");
    failLookup(inRoot("raw"));
    expect(await planReset(await ownedRoot(), "raw")).toEqual({ status: "planned", scope: "raw", files: [] });
  });

  it("E1 refuses at the first planned file whose lookup fails, deleting neither it nor later files", async () => {
    const first = await put("one.md", "1");
    const second = await put("two.md", "2");
    failLookup(first);
    const outcome = await execute({ status: "planned", scope: "wiki", files: ["one.md", "two.md"] });
    expect(outcome).toEqual({ status: "refused", scope: "wiki", reason: "could not delete one.md" });
    expect([await present(first), await present(second)]).toEqual([true, true]);
  });
});

describe("the reset's own disk calls, by argument", () => {
  it("A1 makes exactly these calls for the dry run, the backup, a directory plan and a one-file execution", async () => {
    await recording(() => stateResetCommand());
    expect(io.calls).toStrictEqual([["existsSync", statePath()]]);

    await put(STATE_FILE, STATE_BYTES);
    await recording(resetYes);
    expect(io.calls).toStrictEqual([["existsSync", statePath()], ["lstat", bakPath()], ["rename", statePath(), bakPath()]]);

    await put("raw/x.md", "x");
    await recording(async () => planReset(await ownedRoot(), "raw"));
    expect(io.calls).toStrictEqual([["lstat", inRoot("raw")], ["readdir", inRoot("raw"), { recursive: true, withFileTypes: true }]]);

    const solo = await put("solo.md", "solo");
    const outcome = await recording(() => execute({ status: "planned", scope: "wiki", files: ["solo.md"] }));
    expect(outcome).toEqual({ status: "deleted", scope: "wiki", deleted: ["solo.md"] });
    expect(io.calls.filter((call) => call[1] === solo)).toStrictEqual([["lstat", solo], ["lstat", solo]]);
  });
});
