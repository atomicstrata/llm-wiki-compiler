/**
 * @file test/storage/viewer-project-reads.test.ts
 * @description FIXED outcomes for the viewer's project reads that reach the
 * disk through `src/storage/`: the snapshot's `wiki/index.md` read (resolve the
 * root, resolve the index, require the resolved path to be the literal one,
 * then read it once), the source-review target check (one no-follow lookup
 * whose only meaning is "nothing is there"), and the three canonicalisation
 * calls in the viewer's path helpers.
 *
 * What is pinned is what a caller observes and what the migration must not
 * change: a regular index comes back as its exact text; a missing, linked or
 * unreadable index is "unavailable" with an empty body and is NEVER READ; the
 * target is "absent" only when the lookup says nothing is there, so a file, a
 * directory, a dangling link and a lookup that fails for another reason are
 * all "present or unreadable"; the path helpers reject with the resolver's own
 * error and issue their canonicalisations in a fixed order.
 *
 * "Never read" cannot be seen on a real run, because an absent call leaves no
 * trace. It is shown here by recording every call through a module mock of
 * `fs/promises` that forwards to the real filesystem and can fail one chosen
 * call on one chosen path. The index read itself is the public non-blocking
 * no-follow open, so the call that reads it is an `open`, not a `readFile`.
 * The storage files import `node:fs/promises`; the mock reaching them is part
 * of what is shown.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as real from "fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type Watched = "realpath" | "readFile" | "lstat" | "open";
/** Every watched call seen, and one planted failure per call and path. */
const watch = { seen: [] as string[], fail: new Map<string, Error>() };

// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realFsPromises = { ...(await import("fs/promises")) };

vi.mock("fs/promises", () => {
  const disk = realFsPromises;
  const forward = (call: Watched) => (target: unknown, ...rest: unknown[]): unknown => {
    watch.seen.push(`${call} ${String(target)}${rest.map((value) => ` | ${JSON.stringify(value)}`).join("")}`);
    const failure = watch.fail.get(`${call} ${String(target)}`);
    if (failure) return Promise.reject(failure);
    return (disk[call] as (...args: unknown[]) => unknown)(target, ...rest);
  };
  return { ...disk, realpath: forward("realpath"), readFile: forward("readFile"), lstat: forward("lstat"), open: forward("open") };
});

import { buildViewerSnapshot } from "../../src/viewer/snapshot.js";
import { collectSourceReview } from "../../src/viewer/source-review/report.js";
import { assertViewerSubtree, resolveUnderRoot } from "../../src/viewer/path-safety.js";
import { createDemo } from "../fixtures/source-review-project.js";

const ACCENTED = "# Index — Zoë's café ✓\n\nLinks to [[alpha]].\n";
const UNAVAILABLE = { available: false, body: "" };
let root = "";
const inside = (relative: string): string => path.join(root, relative);
const indexPath = (): string => inside("wiki/index.md");
/** The recorded calls that name `needle`, with the project root removed. */
const callsOn = (needle: string): string[] => watch.seen.filter((entry) => entry.includes(needle)).map((entry) => entry.split(`${root}/`).join(""));

/** Make `call` on `target` reject with a coded error, and return that error. */
function plant(call: Watched, target: string, code: string): Error {
  const error = Object.assign(new Error(`planted ${call} ${code}`), { code });
  watch.fail.set(`${call} ${target}`, error);
  return error;
}

/** The index part of a freshly built snapshot, with the record started clean. */
async function indexOf(): Promise<{ available: boolean; body: string }> {
  watch.seen = [];
  const { available, body } = (await buildViewerSnapshot(root)).index;
  return { available, body };
}

beforeEach(async () => {
  root = await real.realpath(await real.mkdtemp(path.join(tmpdir(), "viewer-project-reads-")));
  await real.mkdir(inside("wiki/concepts"), { recursive: true });
  watch.seen = [];
  watch.fail.clear();
});

afterEach(async () => {
  watch.fail.clear();
  await real.rm(root, { recursive: true, force: true });
});

describe("snapshot index read", () => {
  it("returns a regular index unchanged, resolving it and then reading it once", async () => {
    await real.writeFile(indexPath(), ACCENTED);
    expect(await indexOf()).toEqual({ available: true, body: ACCENTED });
    // Public #276 parity: the index is opened non-blocking and no-follow, then read
    // from that handle, so a planted named pipe cannot stall a snapshot refresh.
    // The open flags are platform constants and are not pinned.
    expect(callsOn("wiki/index.md").map((entry) => entry.split(" | ")[0])).toEqual(["realpath wiki/index.md", "open wiki/index.md"]);
    expect(watch.seen.indexOf(`realpath ${root}`)).toBeGreaterThanOrEqual(0);
    expect(watch.seen.indexOf(`realpath ${root}`)).toBeLessThan(watch.seen.indexOf(`realpath ${indexPath()}`));
  });

  it("reports a missing index as unavailable and reads nothing", async () => {
    expect(await indexOf()).toEqual(UNAVAILABLE);
    expect(callsOn("wiki/index.md")).toEqual(["realpath wiki/index.md"]);
  });

  it("never reads an index that is a link, even to a file inside the project", async () => {
    await real.writeFile(inside("README.md"), "not the index\n");
    await real.symlink(inside("README.md"), indexPath());
    expect(await indexOf()).toEqual(UNAVAILABLE);
    expect(watch.seen.filter((entry) => /^(readFile|open) /u.test(entry) && /index\.md|README\.md/u.test(entry))).toEqual([]);
  });

  it("never reads an index reached through a linked wiki directory", async () => {
    await real.rm(inside("wiki"), { recursive: true });
    await real.mkdir(inside("elsewhere"));
    await real.writeFile(inside("elsewhere/index.md"), ACCENTED);
    await real.symlink(inside("elsewhere"), inside("wiki"));
    expect(await indexOf()).toEqual(UNAVAILABLE);
    expect(watch.seen.filter((entry) => /^(readFile|open) /u.test(entry) && entry.includes("index.md"))).toEqual([]);
  });

  it("reports unavailable when resolving the index fails, and when the read fails", async () => {
    await real.writeFile(indexPath(), ACCENTED);
    plant("realpath", indexPath(), "EACCES");
    expect(await indexOf()).toEqual(UNAVAILABLE);
    expect(callsOn("wiki/index.md")).toEqual(["realpath wiki/index.md"]);
    watch.fail.clear();
    plant("open", indexPath(), "EIO");
    expect(await indexOf()).toEqual(UNAVAILABLE);
  });
});

describe("source-review target check", () => {
  const TARGET = "wiki/concepts/request-timeouts.md";
  /** The demo project, with its one proposal expecting the target to be absent. */
  async function expectingAbsence(): Promise<void> {
    await real.rm(root, { recursive: true, force: true });
    root = await real.realpath(await createDemo());
    const file = inside(".llmwiki/candidates/timeout-proposal.json");
    const candidate = JSON.parse(await real.readFile(file, "utf8")) as Record<string, unknown>;
    delete candidate.expectedTargetHash;
    await real.writeFile(file, JSON.stringify({ ...candidate, expectTargetAbsent: true }));
  }
  const target = async (): Promise<string> => (await collectSourceReview(root)).pages[0]!.candidates[0]!.checks.target;

  it("observes absence only when nothing is there", async () => {
    await expectingAbsence();
    expect(await target()).toBe("expected absent; present or unreadable");
    await real.unlink(inside(TARGET));
    watch.seen = [];
    expect(await target()).toBe("expected absence observed");
    expect(callsOn(TARGET).filter((entry) => entry.startsWith("lstat"))).toContain(`lstat ${TARGET}`);
  });

  it("treats a directory and a dangling link at the target as present", async () => {
    await expectingAbsence();
    await real.unlink(inside(TARGET));
    await real.mkdir(inside(TARGET));
    expect(await target()).toBe("expected absent; present or unreadable");
    await real.rmdir(inside(TARGET));
    await real.symlink("no-such-target.md", inside(TARGET));
    expect(await target()).toBe("expected absent; present or unreadable");
  });

  it("does not take a lookup that fails for another reason as absence", async () => {
    await expectingAbsence();
    await real.unlink(inside(TARGET));
    plant("lstat", inside(TARGET), "EACCES");
    expect(await target()).toBe("expected absent; present or unreadable");
  });
});

describe("viewer path helpers", () => {
  it("resolveUnderRoot resolves the root and then the target, and rejects with the resolver's own error", async () => {
    await real.writeFile(inside("wiki/concepts/a.md"), "x");
    expect(await resolveUnderRoot(root, "wiki", "concepts", "a.md")).toBe(inside("wiki/concepts/a.md"));
    expect(watch.seen).toEqual([`realpath ${root}`, `realpath ${inside("wiki/concepts/a.md")}`]);
    const error = plant("realpath", inside("wiki/concepts/a.md"), "ELOOP");
    await expect(resolveUnderRoot(root, "wiki", "concepts", "a.md")).rejects.toBe(error);
  });

  it("assertViewerSubtree issues its six canonicalisations in a fixed order and falls back for an absent directory", async () => {
    await assertViewerSubtree(root, inside("sources/x.md"));
    expect(watch.seen.map((entry) => entry.split(`${root}/`).join(""))).toEqual([
      `realpath ${root}`, "realpath wiki", "realpath wiki/concepts", "realpath wiki/queries", "realpath sources", "realpath .llmwiki/last-lint.json",
    ]);
    await expect(assertViewerSubtree(root, inside("elsewhere/x.md"))).rejects.toThrow(/outside the viewer-approved subtrees/);
  });
});
