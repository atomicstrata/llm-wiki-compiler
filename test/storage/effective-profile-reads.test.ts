/**
 * @file test/storage/effective-profile-reads.test.ts
 * @description The effective-profile read journey through its REAL callers
 * (`loadProfile`, `resolveActiveProduct`) after its handle work moved into
 * `src/storage/`. One narrow wrapper around the no-follow opener records every
 * open and every call made on the handle it returns, by leaf name, and can
 * make one of them fail. Nothing else is mocked: files are real.
 *
 * These cases pin only what the move could silently change and no existing
 * test states: the order of handle calls, that an over-cap leaf is never
 * read, that a read failure rejects RAW while an open failure is mapped, what
 * a rejecting close does, that every opened handle is closed exactly once,
 * the order in which the product route opens its leaves, and that a dangling
 * link named `profile.json` beside a binding is still a conflict.
 */

import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "bun:test";

/** `calls` are "<operation> <leaf name>"; `fail` maps one such key to the error it should raise. */
const io = { calls: [] as string[], fail: new Map<string, Error>() };

// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realUtilsNoFollowOpen = { ...(await import("../../src/utils/no-follow-open.js")) };

vi.mock("../../src/utils/no-follow-open.js", async () => {
  const actual = realUtilsNoFollowOpen;
  const WATCHED = ["stat", "readFile", "read", "close"];
  /** Record `key`, then raise its planted failure if there is one. */
  const note = (key: string): void => {
    io.calls.push(key);
    const planted = io.fail.get(key);
    if (planted) throw planted;
  };
  /** Record the open of `file`, and every watched call later made on the handle it yields. */
  const watched = async <T>(file: string, open: () => Promise<T>, handleOf: (opened: T) => object): Promise<T> => {
    const name = file.slice(file.lastIndexOf("/") + 1);
    note(`open ${name}`);
    const opened = await open();
    const handle = handleOf(opened);
    const operations = handle as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const operation of WATCHED) {
      const real = operations[operation]!.bind(handle);
      operations[operation] = async (...args) => {
        if (operation === "close") await real();
        note(`${operation} ${name}`);
        return operation === "close" ? undefined : real(...args);
      };
    }
    return opened;
  };
  const openFileNoFollow = (file: string, flags: number, mode?: number) =>
    watched(file, () => actual.openFileNoFollow(file, flags, mode), (handle) => handle);
  // The regular-file opener's own fstat runs before it returns, like the open itself.
  const openRegularNoFollow = (file: string, flags: number, mode?: number) =>
    watched(file, () => actual.openRegularNoFollow(file, flags, mode), (opened) => opened.handle);
  return { ...actual, openFileNoFollow, openRegularNoFollow };
});

import { ProfileLoadError, loadProfile } from "../../src/profile/load.js";
import { ProductAuthorityConflictError } from "../../src/products/binding/problems.js";
import { knowledgeProfileMemberPath } from "../../src/products/binding/manifest-authority.js";
import { resolveActiveProduct } from "../../src/products/binding/resolve.js";
import { writeActiveProductBinding } from "../../src/products/binding/store.js";
import { digestDirectoryName } from "../../src/products/ids.js";
import { productStorePaths } from "../../src/products/paths.js";
import { MAX_PROFILE_BYTES, PROFILE_FILE } from "../../src/utils/constants.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { bindingFor, buildProfileOnlyProduct, commitBuilt } from "../products/binding-fixture.js";

const LEAF = "profile.json";
const VALID = JSON.stringify({ schemaVersion: 1, profileId: "legacy", displayName: "Legacy", entities: { notes: { directory: "wiki/notes" } } });
const root = useTempRoot();
const profilePath = (): string => path.join(root.dir, PROFILE_FILE);
const callsOn = (name: string): string[] => io.calls.filter((call) => call.endsWith(` ${name}`)).map((call) => call.split(" ")[0]!);
const count = (operation: string): number => io.calls.filter((call) => call.startsWith(`${operation} `)).length;

/** Write `content` as the project's legacy profile file. */
async function writeLegacyProfile(content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(profilePath()), { recursive: true });
  await writeFile(profilePath(), content);
}

/** Install and bind a healthy product, then forget the calls that setup made. */
async function activateProduct() {
  const product = buildProfileOnlyProduct();
  await commitBuilt(root.dir, product);
  await writeActiveProductBinding(root.dir, bindingFor(product.manifest));
  io.calls.length = 0;
  const packageHex = digestDirectoryName(product.manifest.packageDigest);
  const memberHexes = product.manifest.members.map((member) => digestDirectoryName(member.digest));
  return { product, packageHex, memberHexes, paths: productStorePaths(root.dir) };
}

beforeEach(() => { io.calls.length = 0; io.fail.clear(); });

describe("legacy profile read", () => {
  it("opens, sizes, reads and closes the leaf once, in that order", async () => {
    await writeLegacyProfile(VALID);
    const loaded = await loadProfile(root.dir);
    expect(loaded.profile.profileId).toBe("legacy");
    expect(loaded.loadedFrom).toBe(profilePath());
    expect(callsOn(LEAF)).toEqual(["open", "stat", "readFile", "close"]);
  });

  it("refuses a leaf over the cap without reading it, and still closes it", async () => {
    await writeLegacyProfile("x".repeat(MAX_PROFILE_BYTES + 1));
    await expect(loadProfile(root.dir)).rejects.toThrow(
      new ProfileLoadError(`${PROFILE_FILE} is ${MAX_PROFILE_BYTES + 1} bytes — exceeds the ${MAX_PROFILE_BYTES}-byte cap`));
    expect(callsOn(LEAF)).toEqual(["open", "stat", "close"]);
  });

  it("lets a failed read reject with the raw error, not a ProfileLoadError, and closes once", async () => {
    const fault = Object.assign(new Error("read sabotaged"), { code: "EIO" });
    await writeLegacyProfile(VALID);
    io.fail.set(`readFile ${LEAF}`, fault);
    await expect(loadProfile(root.dir)).rejects.toBe(fault);
    expect(callsOn(LEAF)).toEqual(["open", "stat", "readFile", "close"]);
  });

  it("maps a failed open that is neither absence nor a link to ProfileLoadError", async () => {
    await writeLegacyProfile(VALID);
    io.fail.set(`open ${LEAF}`, Object.assign(new Error("open sabotaged"), { code: "EACCES" }));
    await expect(loadProfile(root.dir)).rejects.toThrow(new ProfileLoadError(`Failed to read ${PROFILE_FILE}: open sabotaged`));
  });

  it("rejects with a failing close even though the text was ready", async () => {
    const fault = new Error("close sabotaged");
    await writeLegacyProfile(VALID);
    io.fail.set(`close ${LEAF}`, fault);
    await expect(loadProfile(root.dir)).rejects.toBe(fault);
  });
});

describe("product-mode reads", () => {
  it("opens the binding, the manifest, each member in manifest order, and the knowledge profile no second time", async () => {
    const { product, memberHexes } = await activateProduct();
    const loaded = await loadProfile(root.dir);
    expect(loaded.loadedFrom).toBe(
      knowledgeProfileMemberPath(root.dir, product.manifest.packageDigest, product.manifest.knowledgeProfile.digest));
    const opens = io.calls.filter((call) => call.startsWith("open ")).map((call) => call.slice("open ".length));
    // The knowledge profile is loaded from the bytes its member check hashed and kept, so its leaf is opened once.
    expect(opens).toEqual(["active-product.json", "manifest.json", ...memberHexes]);
    expect(count("close")).toBe(count("open"));
  });

  it("treats a dangling link named profile.json beside a binding as a conflict", async () => {
    await activateProduct();
    await symlink(path.join(root.dir, "nowhere.json"), profilePath());
    expect(await resolveActiveProduct(root.dir)).toEqual({ mode: "conflict" });
    await expect(loadProfile(root.dir)).rejects.toBeInstanceOf(ProductAuthorityConflictError);
  });

  it("refuses a member replaced at the same length after hashing it, and closes it", async () => {
    const { product, packageHex, memberHexes, paths } = await activateProduct();
    const tampered = Buffer.from(product.bytesByHex.get(memberHexes[0]!)!);
    tampered[0] ^= 0xff;
    await writeFile(paths.memberFile(packageHex, memberHexes[0]!), tampered);
    expect(await resolveActiveProduct(root.dir)).toEqual({ mode: "unavailable", detail: "package-invalid" });
    expect(callsOn(memberHexes[0]!).filter((call) => call !== "read")).toEqual(["open", "stat", "close"]);
    expect(callsOn(memberHexes[0]!)).toContain("read");
  });

  it("refuses a member of another size without reading a byte of it", async () => {
    const { product, packageHex, memberHexes, paths } = await activateProduct();
    const shorter = product.bytesByHex.get(memberHexes[0]!)!.subarray(1);
    await writeFile(paths.memberFile(packageHex, memberHexes[0]!), shorter);
    expect(await resolveActiveProduct(root.dir)).toEqual({ mode: "unavailable", detail: "package-invalid" });
    expect(callsOn(memberHexes[0]!)).toEqual(["open", "close"]);
  });
});
