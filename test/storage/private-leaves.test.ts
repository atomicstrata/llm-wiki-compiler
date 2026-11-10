/**
 * @file test/storage/private-leaves.test.ts
 * @description The four physical reads the embedding index, its retry markers
 * and its legacy raw reader moved onto (`src/storage/disk-private-leaves.ts`),
 * exercised on a temp directory.
 *
 * Every expectation here is a FIXED outcome, written down from what the
 * callers' inline code did before the move. Nothing is compared with the
 * primitive a function happens to call, because that would only show a wrapper
 * agrees with itself.
 *
 * The three reads look alike and are deliberately different, so the same
 * shapes and the same three injected faults (a failing `stat`, a failing read,
 * a failing `close`) are put to each one and the differences are the point:
 * the marker read never rejects; the legacy text read rejects for everything
 * except "nothing usable there"; the byte read rejects for everything except
 * "over the cap". One narrow mock of the no-follow opener injects the faults.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** The handle operations ("stat", "readFile", "close") the opened handle should fail at. */
const failing = (() => new Set<string>())();

// Snapshot real modules before mock.module replaces them for this file.
const realUtilsNoFollowOpen = { ...(await import("../../src/utils/no-follow-open.js")) };

vi.mock("../../src/utils/no-follow-open.js", async () => {
  const actual = realUtilsNoFollowOpen as typeof import("../../src/utils/no-follow-open.js");
  /** A view of a real handle whose named operations reject; `close` still really closes first. */
  const sabotaged = <T extends object>(handle: T): T => new Proxy(handle, {
    get(target, key) {
      const real = Reflect.get(target, key) as unknown;
      if (typeof real !== "function") return real;
      const call = (...args: unknown[]): unknown => (real as (...rest: unknown[]) => unknown).apply(target, args);
      if (!failing.has(String(key))) return call;
      return async () => { if (key === "close") await call(); throw new Error(`${String(key)} sabotaged`); };
    },
  });
  return { ...actual, openFileNoFollow: async (file: string, flags: number, mode?: number) => sabotaged(await actual.openFileNoFollow(file, flags, mode)) };
});

import {
  leafKindNoFollow, readPrivateLeafBytes, readPrivateLeafText, readPrivateLeafTextOrThrow,
} from "../../src/storage/disk-private-leaves.js";

const NOT_UTF8 = Buffer.from([0x00, 0xff, 0xfe, 0xc3, 0x28, 0x0a]);
const TEXT = "[\"concept:alpha\"]";

let dir: string;
const at = (name: string): string => path.join(dir, name);

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "llmwiki-private-leaves-")));
  failing.clear();
  await writeFile(at("leaf.json"), TEXT);
  await writeFile(at("blob.bin"), NOT_UTF8);
  await mkdir(at("directory"));
  await symlink(at("leaf.json"), at("linked.json"));
  await symlink(at("nowhere.json"), at("dangling.json"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** How a promise settled: its value, or the rejection's code or message. */
function settled<T>(work: Promise<T>): Promise<T | string> {
  return work.catch((error: NodeJS.ErrnoException) => `rejected:${error.code ?? error.message}`);
}

describe("leafKindNoFollow", () => {
  it("tells absent, a regular file and anything else apart without following a link", async () => {
    expect(await leafKindNoFollow(at("absent.json"))).toBe("absent");
    expect(await leafKindNoFollow(at("leaf.json"))).toBe("regular");
    expect(await leafKindNoFollow(at("directory"))).toBe("other");
    expect(await leafKindNoFollow(at("linked.json"))).toBe("other");
    expect(await leafKindNoFollow(at("dangling.json"))).toBe("other");
    expect(await settled(leafKindNoFollow(at("leaf.json/child")))).toBe("rejected:ENOTDIR");
  });
});

describe("readPrivateLeafText, the marker read: never rejects", () => {
  it("is ok for a regular leaf within the cap, absent for ENOENT, unavailable for the rest", async () => {
    expect(await readPrivateLeafText(at("leaf.json"), TEXT.length)).toEqual({ kind: "ok", body: TEXT });
    expect(await readPrivateLeafText(at("absent.json"), 64)).toEqual({ kind: "absent" });
    expect(await readPrivateLeafText(at("linked.json"), 64)).toEqual({ kind: "unavailable" });
    expect(await readPrivateLeafText(at("dangling.json"), 64)).toEqual({ kind: "unavailable" });
    expect(await readPrivateLeafText(at("directory"), 64)).toEqual({ kind: "unavailable" });
    expect(await readPrivateLeafText(at("leaf.json"), TEXT.length - 1)).toEqual({ kind: "unavailable" });
  });

  it("turns a failing stat or read into unavailable and ignores a failing close", async () => {
    failing.add("close");
    expect(await readPrivateLeafText(at("leaf.json"), 64)).toEqual({ kind: "ok", body: TEXT });
    failing.add("readFile");
    expect(await readPrivateLeafText(at("leaf.json"), 64)).toEqual({ kind: "unavailable" });
    failing.delete("readFile"); failing.add("stat");
    expect(await readPrivateLeafText(at("leaf.json"), 64)).toEqual({ kind: "unavailable" });
  });
});

describe("readPrivateLeafTextOrThrow, the legacy raw read: null or a raw rejection", () => {
  it("is text for a regular leaf and null for absent, a link, a non-regular leaf and over the cap", async () => {
    expect(await readPrivateLeafTextOrThrow(at("leaf.json"), TEXT.length)).toBe(TEXT);
    expect(await readPrivateLeafTextOrThrow(at("absent.json"), 64)).toBeNull();
    expect(await readPrivateLeafTextOrThrow(at("linked.json"), 64)).toBeNull();
    expect(await readPrivateLeafTextOrThrow(at("directory"), 64)).toBeNull();
    expect(await readPrivateLeafTextOrThrow(at("leaf.json"), TEXT.length - 1)).toBeNull();
  });

  it("rejects for a failing stat, a failing read and a failing close", async () => {
    failing.add("close");
    expect(await settled(readPrivateLeafTextOrThrow(at("leaf.json"), 64))).toBe("rejected:close sabotaged");
    expect(await settled(readPrivateLeafTextOrThrow(at("leaf.json"), 1))).toBe("rejected:close sabotaged");
    expect(await settled(readPrivateLeafTextOrThrow(at("absent.json"), 64))).toBeNull();
    failing.clear(); failing.add("readFile");
    expect(await settled(readPrivateLeafTextOrThrow(at("leaf.json"), 64))).toBe("rejected:readFile sabotaged");
    failing.clear(); failing.add("stat");
    expect(await settled(readPrivateLeafTextOrThrow(at("leaf.json"), 64))).toBe("rejected:stat sabotaged");
  });
});

describe("readPrivateLeafBytes, the index read: null only for over the cap", () => {
  it("returns exact bytes, null over the cap, and rejects for absent, a link and a directory", async () => {
    expect(await readPrivateLeafBytes(at("blob.bin"), NOT_UTF8.length)).toEqual(NOT_UTF8);
    expect(await readPrivateLeafBytes(at("blob.bin"), NOT_UTF8.length - 1)).toBeNull();
    expect(await settled(readPrivateLeafBytes(at("absent.json"), 64))).toBe("rejected:ENOENT");
    expect(String(await settled(readPrivateLeafBytes(at("linked.json"), 64)))).toMatch(/^rejected:/u);
    expect(String(await settled(readPrivateLeafBytes(at("directory"), 64)))).toMatch(/^rejected:/u);
  });

  it("rejects for a failing stat, a failing read, and a failing close even when over the cap", async () => {
    failing.add("close");
    expect(await settled(readPrivateLeafBytes(at("blob.bin"), 64))).toBe("rejected:close sabotaged");
    expect(await settled(readPrivateLeafBytes(at("blob.bin"), 1))).toBe("rejected:close sabotaged");
    failing.clear(); failing.add("readFile");
    expect(await settled(readPrivateLeafBytes(at("blob.bin"), 64))).toBe("rejected:readFile sabotaged");
    failing.clear(); failing.add("stat");
    expect(await settled(readPrivateLeafBytes(at("blob.bin"), 64))).toBe("rejected:stat sabotaged");
  });
});
