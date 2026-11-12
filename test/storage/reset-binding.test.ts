/**
 * @file test/storage/reset-binding.test.ts
 * @description The reset family as root-free bodies, each against its
 * unchanged root facade: the scoped plan (`planResetFrom`), its execution
 * (`executeResetFrom`), the state dry run (`previewStateResetWith`) and the
 * confirmed state reset (`resetStateFileWith`).
 *
 * HOW IT IS BUILT. A real temp project (owned by `tempRootTracker`) is planned,
 * executed and state-reset through the root facades. The same layouts are then
 * given to the bodies as memory reads, leaves and steps that log every call.
 * The facade's answers must equal the bodies'. For the state path, each line the
 * command prints is matched to the notice the memory body reported, interleaved
 * with the lock exactly as before. Memory cases pin each body's ladder and
 * order. The last cases show that the bodies make no ambient call, and that the
 * root facades reach each incumbent mechanism with exact arguments.
 *
 * NOT SHOWN HERE: the exact `fs` calls and printed bytes (`reset-disk-calls`),
 * the real lock (the built-CLI tests) and the confinement helpers themselves.
 */

import { lstat, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mocked } from "../mocked.js";
import {
  executeReset, executeResetFrom, planReset, planResetFrom, RESET_SCOPES,
  type ResetDeleteLeaves, type ResetPlanReads, type ResetPlanV1,
} from "../../src/commands/reset-plan.js";
import {
  previewStateResetWith, resetStateFileWith, stateResetCommand, type StateResetNotice, type StateResetSteps,
} from "../../src/commands/state-reset.js";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import * as guardedLeaves from "../../src/storage/disk-guarded-leaves.js";
import * as localReads from "../../src/storage/disk-local-reads.js";
import * as locations from "../../src/storage/disk-locations.js";
import * as confinedDelete from "../../src/utils/confined-delete.js";
import { STATE_FILE } from "../../src/utils/constants.js";
import * as lock from "../../src/utils/lock.js";
import * as output from "../../src/utils/output.js";
import * as pathConfine from "../../src/utils/path-confine.js";
import { tempRootTracker } from "../temp-roots.js";

const tracker = tempRootTracker();
const MEM = path.resolve("/memory/project");
/** The files of the one layout both the real project and the memory tree hold. */
const FILES = [
  path.join("wiki", "concepts", "alpha.md"), path.join("wiki", "top.md"), path.join("raw", "source.txt"), "log.md",
  STATE_FILE, path.join(".llmwiki", "runs", "prr_1", "manifest.json"),
];
/** A fragment of the first line each notice prints. */
const LINES: Record<StateResetNotice, string> = {
  "no-state": "No state file to reset.", plan: "Will back up", escape: "escapes the project root",
  busy: "Another llmwiki process", "bak-not-regular": "is not a regular file", reset: "Backup saved to",
};
const FAILURES: readonly StateResetNotice[] = ["escape", "busy", "bak-not-regular"];
let events: string[] = [];
let exitCodeBefore: typeof process.exitCode;

beforeEach(() => {
  events = [];
  exitCodeBefore = process.exitCode;
  vi.spyOn(output, "status").mockImplementation((_icon: string, message: string) => {
    const code = (Object.keys(LINES) as StateResetNotice[]).find((key) => message.includes(LINES[key]));
    if (code !== undefined) events.push(`notice ${code}`);
  });
  vi.spyOn(lockGate, "acquireMutationLock").mockImplementation(async () => { events.push("lock"); return true; });
  vi.spyOn(lock, "releaseLock").mockImplementation(async () => { events.push("release"); });
});
afterEach(async () => {
  process.exitCode = exitCodeBefore;
  vi.restoreAllMocks();
  await tracker.cleanup();
});

/** A real project holding `files`, each with a little text. */
async function realProject(files: readonly string[] = FILES): Promise<string> {
  const root = await tracker.create("reset-binding-", { real: true });
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), file, "utf8");
  }
  return root;
}

/** `file` is `target` or lies under it. */
const under = (file: string, target: string): boolean => file === target || file.startsWith(target + path.sep);

/** Memory plan reads over `files` under {@link MEM}; `escapes` names targets that resolve elsewhere. Unordered on purpose. */
function memoryPlanReads(log: string[], files: readonly string[], escapes: Record<string, string> = {}): ResetPlanReads {
  const real = files.map((file) => path.join(MEM, file));
  return {
    realRoot: async () => { log.push("root"); return MEM; },
    realPathOf: async (relative) => {
      log.push(`real ${relative}`);
      const target = path.join(MEM, relative);
      return escapes[relative] ?? (real.some((file) => under(file, target)) ? target : null);
    },
    filesUnder: async (target) => {
      log.push(`files ${path.relative(MEM, target)}`);
      return real.filter((file) => under(file, target)).map((file) => path.relative(MEM, file)).reverse();
    },
  };
}

/** A raw error carrying `code`. */
const fault = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

/** Memory delete leaves; `looks` and `unlinks` map a file to the code its call rejects with. */
function memoryLeaves(log: string[], looks: Record<string, string> = {}, unlinks: Record<string, string> = {}): ResetDeleteLeaves {
  return {
    kindNoFollow: async (relative) => {
      log.push(`look ${relative}`);
      const code = looks[relative];
      if (code !== undefined) throw fault(code);
      return "file";
    },
    unlinkConfined: async (relative) => {
      log.push(`unlink ${relative}`);
      const code = unlinks[relative];
      if (code !== undefined) throw fault(code);
    },
  };
}

/** One memory world for the state path. `bak` is the backup's kind, absent when unset, or a fault its look rejects with. */
interface StateWorld { dir?: "absent" | "escape"; locked?: boolean; state?: boolean; bak?: string | Error; renameFault?: Error }

/** Memory state steps over `world`, logging each call; the root is `/memory/real` and the state lives in its `.llmwiki`. */
function memorySteps(log: string[], world: StateWorld = {}): StateResetSteps {
  return {
    statePresent: () => { log.push("present"); return world.state ?? true; },
    realLlmwikiDir: async () => {
      log.push("dir");
      return world.dir === "absent" ? null : world.dir === "escape" ? "/memory/elsewhere/.llmwiki" : "/memory/real/.llmwiki";
    },
    realRoot: async () => { log.push("root"); return "/memory/real"; },
    acquireLock: async () => { log.push("lock"); return world.locked !== true; },
    releaseLock: async () => { log.push("release"); },
    exists: (location) => { log.push(`exists ${location}`); return world.state ?? true; },
    confineUnderRoot: async (location) => { log.push(`confine ${location}`); return `/memory/confined/${path.basename(location)}`; },
    kindNoFollow: async (location) => {
      log.push(`look ${location}`);
      if (world.bak === undefined || world.bak instanceof Error) throw world.bak ?? fault("ENOENT");
      return world.bak;
    },
    rename: async (from, to) => { log.push(`rename ${from} ${to}`); if (world.renameFault) throw world.renameFault; },
    notice: (code) => { log.push(`notice ${code}`); },
  };
}

/** The memory log as the root command's events show it: the lock and the notices. */
const asEvents = (log: string[]): string[] => log.filter((line) => /^(lock|release|notice )/.test(line));

describe("the scoped reset plan as a root-free body", () => {
  it("R1 plans every scope as the root facade does, from the same layout in memory", async () => {
    const root = await realProject();
    for (const scope of RESET_SCOPES) {
      expect(await planResetFrom(memoryPlanReads([], FILES), scope)).toEqual(await planReset(root, scope));
    }
  });

  it("R2 walks the scope's roots in order, skips an absent one, and refuses at the first that resolves outside", async () => {
    const log: string[] = [];
    const reads = memoryPlanReads(log, [path.join("wiki", "b.md"), path.join("wiki", "a.md")], { raw: "/elsewhere/raw" });
    expect(await planResetFrom(reads, "all")).toEqual({ status: "unavailable", scope: "all", reason: "raw resolves outside the project root" });
    expect(log).toEqual(["root", `real ${STATE_FILE}`, "real wiki", "files wiki", "real raw"]);
    expect(await planResetFrom(memoryPlanReads([], [path.join("wiki", "b.md"), path.join("wiki", "a.md")]), "wiki"))
      .toEqual({ status: "planned", scope: "wiki", files: [path.join("wiki", "a.md"), path.join("wiki", "b.md")] });
  });

});

describe("the scoped reset execution as a root-free body", () => {
  it("R3 executes a plan as the root facade does, and leaves every directory in place", async () => {
    const root = await realProject();
    const plan = await planReset(root, "wiki");
    const onDisk = await executeReset(root, "wiki", plan);
    expect(await executeResetFrom(memoryLeaves([]), "wiki", plan)).toEqual(onDisk);
    expect(onDisk).toEqual({ status: "deleted", scope: "wiki", deleted: [path.join("wiki", "concepts", "alpha.md"), path.join("wiki", "top.md")] });
    expect((await lstat(path.join(root, "wiki", "concepts"))).isDirectory()).toBe(true);
    expect(await readdir(path.join(root, "wiki"))).toEqual(["concepts"]);
  });

  it("R4 skips a vanished file at either step, refuses at the first other failure, and touches nothing after it", async () => {
    const plan: ResetPlanV1 = { status: "planned", scope: "raw", files: ["gone.md", "a.md", "raced.md", "bad.md", "c.md"] };
    const log: string[] = [];
    const outcome = await executeResetFrom(memoryLeaves(log, { "gone.md": "ENOENT" }, { "raced.md": "ENOENT", "bad.md": "EACCES" }), "raw", plan);
    expect(outcome).toEqual({ status: "refused", scope: "raw", reason: "could not delete bad.md" });
    expect(log).toEqual(["look gone.md", "look a.md", "unlink a.md", "look raced.md", "unlink raced.md", "look bad.md", "unlink bad.md"]);
    const lookLog: string[] = [];
    expect(await executeResetFrom(memoryLeaves(lookLog, { "gone.md": "ENOENT", "a.md": "EACCES" }), "raw", plan)).toEqual({ status: "refused", scope: "raw", reason: "could not delete a.md" });
    expect(lookLog).toEqual(["look gone.md", "look a.md"]);
  });

  it("R5 refuses an unavailable plan with its reason before any leaf is asked", async () => {
    const log: string[] = [];
    const plan: ResetPlanV1 = { status: "unavailable", scope: "wiki", reason: "wiki resolves outside the project root" };
    expect(await executeResetFrom(memoryLeaves(log), "wiki", plan)).toEqual({ status: "refused", scope: "wiki", reason: plan.reason });
    expect(log).toEqual([]);
  });
});

/** Run the root command in `root` and return its lock and notice events and its exit code. */
async function commandIn(root: string, yes: boolean): Promise<[string[], typeof process.exitCode]> {
  vi.spyOn(process, "cwd").mockReturnValue(root);
  events = [];
  process.exitCode = exitCodeBefore;
  await stateResetCommand({ yes });
  return [events, process.exitCode];
}

/** Run the confirmed body over memory `world` and return the same view the command gives. */
async function bodyOver(world: StateWorld): Promise<[string[], typeof process.exitCode]> {
  const log: string[] = [];
  await resetStateFileWith(memorySteps(log, world));
  const failed = log.some((line) => FAILURES.some((code) => line === `notice ${code}`));
  return [asEvents(log), failed ? 1 : exitCodeBefore];
}

describe("the state reset as root-free bodies", () => {
  it("S1 answers what the root command answers for each real layout, with every line and the lock in the same order", async () => {
    expect(await commandIn(await realProject([]), true)).toEqual(await bodyOver({ dir: "absent" }));
    expect(await commandIn(await realProject([path.join(".llmwiki", "other.json")]), true)).toEqual(await bodyOver({ state: false }));
    expect(await commandIn(await realProject([STATE_FILE, `${STATE_FILE}.bak`]), true)).toEqual(await bodyOver({ bak: "file" }));
    expect(await commandIn(await realProject([STATE_FILE, path.join(`${STATE_FILE}.bak`, "x")]), true)).toEqual(await bodyOver({ bak: "directory" }));
    const escaping = await realProject([]);
    await symlink(await realProject([STATE_FILE]), path.join(escaping, ".llmwiki"));
    expect(await commandIn(escaping, true)).toEqual(await bodyOver({ dir: "escape" }));
    mocked(lockGate.acquireMutationLock).mockImplementation(async () => { events.push("lock"); return false; });
    expect(await commandIn(await realProject([STATE_FILE]), true)).toEqual(await bodyOver({ locked: true }));
  });

  it("S2 decides the dry run from the presence look alone, as the root command does", async () => {
    for (const [files, state] of [[[], false], [[STATE_FILE], true]] as const) {
      const log: string[] = [];
      previewStateResetWith(memorySteps(log, { state }));
      expect(log).toEqual(["present", `notice ${state ? "plan" : "no-state"}`]);
      expect((await commandIn(await realProject(files), false))[0]).toEqual(asEvents(log));
    }
  });

  it("S3 refuses before any lock when .llmwiki is absent or escapes, and takes no further step when the lock is held", async () => {
    for (const [world, expected] of [
      [{ dir: "absent" }, ["dir", "notice no-state"]],
      [{ dir: "escape" }, ["dir", "root", "notice escape"]],
      [{ locked: true }, ["dir", "root", "lock", "notice busy"]],
    ] as const) {
      const log: string[] = [];
      await resetStateFileWith(memorySteps(log, world));
      expect(log).toEqual(expected);
    }
  });

  it("S4 moves the raw state over an absent or regular backup, and a faulted look counts as absent", async () => {
    const STATE = path.join("/memory/real/.llmwiki", path.basename(STATE_FILE));
    const CONFINED = `/memory/confined/${path.basename(STATE_FILE)}`;
    for (const bak of [undefined, "file", fault("EACCES")]) {
      const log: string[] = [];
      await resetStateFileWith(memorySteps(log, { bak }));
      expect(log).toEqual(["dir", "root", "lock", `exists ${STATE}`, `confine ${STATE}`, `look ${CONFINED}.bak`,
        `rename ${CONFINED} ${CONFINED}.bak`, "notice reset", "release"]);
    }
  });

  it("S5 refuses a backup that is not a regular file, and reports a vanished state, each before the release", async () => {
    for (const bak of ["directory", "symlink"]) {
      const log: string[] = [];
      await resetStateFileWith(memorySteps(log, { bak }));
      expect(log.slice(-3)).toEqual([expect.stringMatching(/^look /), "notice bak-not-regular", "release"]);
    }
    const log: string[] = [];
    await resetStateFileWith(memorySteps(log, { state: false }));
    expect(log).toEqual(["dir", "root", "lock", expect.stringMatching(/^exists /), "notice no-state", "release"]);
  });

  it("S6 lets a failed rename propagate uncaught, with no success notice, after releasing the lock", async () => {
    const log: string[] = [];
    await expect(resetStateFileWith(memorySteps(log, { renameFault: fault("EXDEV") }))).rejects.toThrow("EXDEV");
    expect(log.slice(-2)).toEqual([expect.stringMatching(/^rename /), "release"]);
  });
});

describe("the reset family's root delegation", () => {
  /** Pass-through spies on every incumbent mechanism the facades reach. */
  const mechanisms = () => ({
    realpath: vi.spyOn(pathConfine, "safeRealpath"), confine: vi.spyOn(pathConfine, "confineUnderRoot"),
    walk: vi.spyOn(guardedLeaves, "listDirectoryEntriesRecursive"), rename: vi.spyOn(guardedLeaves, "renameLeafUnguarded"),
    look: vi.spyOn(localReads, "locationKindNoFollow"), exists: vi.spyOn(locations, "locationExistsSync"),
    unlink: vi.spyOn(confinedDelete, "unlinkConfinedLeafDurable"),
  });

  it("Z1 makes no ambient call from any body over memory", async () => {
    const spies = mechanisms();
    events = [];
    await planResetFrom(memoryPlanReads([], FILES), "all");
    await executeResetFrom(memoryLeaves([]), "wiki", { status: "planned", scope: "wiki", files: ["a.md"] });
    previewStateResetWith(memorySteps([]));
    await resetStateFileWith(memorySteps([], { bak: "file" }));
    expect(Object.values(spies).map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect([events, mocked(output.status).mock.calls]).toEqual([[], []]);
  });

  it("Z2 reaches each incumbent mechanism from the root facades with exact arguments", async () => {
    const root = await realProject();
    const spies = mechanisms();
    const raw = path.join(root, "raw");
    const plan = await planReset(root, "raw");
    expect([spies.realpath.mock.calls, spies.walk.mock.calls]).toEqual([[[root], [raw]], [[raw]]]);
    await executeReset(root, "raw", plan);
    expect(spies.look).toHaveBeenCalledWith(path.join(raw, "source.txt"));
    expect(spies.unlink).toHaveBeenCalledWith(root, path.join(raw, "source.txt"), raw);
    await commandIn(root, false);
    expect(spies.exists).toHaveBeenCalledWith(path.join(root, STATE_FILE));
    await commandIn(root, true);
    const state = path.join(root, STATE_FILE);
    expect(spies.confine).toHaveBeenCalledWith(state, root, { mustExist: false });
    expect(spies.look).toHaveBeenCalledWith(`${state}.bak`);
    expect(spies.rename).toHaveBeenCalledWith(state, `${state}.bak`);
    expect([mocked(lockGate.acquireMutationLock).mock.calls, mocked(lock.releaseLock).mock.calls]).toEqual([[[root, "ordinary"]], [[root]]]);
  });
});
