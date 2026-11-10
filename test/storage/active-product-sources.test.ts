/**
 * @file test/storage/active-product-sources.test.ts
 * @description Active-product resolution and the installed-package read over
 * their sources. This file uses `resolveActiveProductFrom`,
 * `readInstalledProductPackageFrom` and `loadProfileFrom`, which exist only after
 * those readers were given sources to read through, so it has NO before-edit run.
 *
 * There is no project directory. Two in-memory doubles decide nothing: `binding`
 * (the binding leaf, the alias check, the private-directory resolution and the
 * look at one of its entries) and `packages` (the manifest leaf, one member
 * check, the two directory looks, the two listings, one member's bytes).
 *
 * WHAT IS LOGGED. Every method of both doubles logs its call to ONE shared,
 * ordered log BEFORE it returns or throws, under a name that starts with its
 * group (`binding.` or `packages.`) and carries the cap or names it was passed.
 * So "no package read followed" is an observation on the complete log.
 *
 * The production readers run on what the doubles serve: mode precedence, the
 * alias short circuit and its catch-all, both profile-presence catch-alls, "any
 * entry counts", the digest gate, canonical and directory-name checks, member
 * order and the stop at the first failure, the three directory failures, the
 * undeclared-leaf rule, the component comparison, and which errors leave raw.
 *
 * NOT SHOWN HERE: how the local disk confines a leaf, refuses a link or a hard
 * link, resolves the private directory or hashes a member. The product disk
 * tests and `profile-viewer-legacy.test.ts` show that on real files.
 *
 * The doubles are not a hosted store, not an access-control layer and not
 * `ProjectStore`.
 */

import path from "node:path";
import { describe, expect, it } from "bun:test";
import { loadProfileFrom } from "../../src/profile/load.js";
import { knowledgeProfileMemberPath } from "../../src/products/binding/manifest-authority.js";
import { resolveActiveProductFrom, type ActiveProductSources } from "../../src/products/binding/resolve.js";
import type { ActiveBindingReads } from "../../src/products/binding/store.js";
import { MAX_ACTIVE_PRODUCT_BINDING_BYTES } from "../../src/products/binding/types.js";
import { MAX_KNOWLEDGE_PROFILE_BYTES, MAX_PRODUCT_MANIFEST_BYTES } from "../../src/products/constants.js";
import { digestDirectoryName, type Sha256Digest } from "../../src/products/ids.js";
import {
  readInstalledProductPackageFrom, type PackageDirEntry, type ProductPackageReads,
} from "../../src/products/packages/store.js";
import { bindingFor, buildProfileOnlyProduct, serializeBinding } from "../products/binding-fixture.js";
import { buildProductPackage } from "../products/product-package-fixture.js";

const ROOT = "/display/only/project";
const PRODUCT = buildProfileOnlyProduct();
const HEX = digestDirectoryName(PRODUCT.manifest.packageDigest);
const MEMBERS = PRODUCT.manifest.members.map((member) => digestDirectoryName(member.digest));
const KNOWLEDGE = digestDirectoryName(PRODUCT.manifest.knowledgeProfile.digest);
const file = (name: string): PackageDirEntry => ({ name, isFile: true, isDirectory: false });
type Answer<T> = T | Error;
/** Serve a held answer, or reject with the held `Error` itself. */
const serve = <T>(answer: Answer<T>): T => { if (answer instanceof Error) throw answer; return answer; };

interface Held {
  /** The binding leaf: bytes, a refusal kind, or an `Error` the read rejects with. */
  leaf?: Answer<Buffer | "absent" | "unavailable">;
  alias?: Answer<boolean>;
  privateDir?: Answer<string | null>;
  /** What the look at `profile.json` answers; an `Error` makes it reject (as a missing entry does on disk). */
  profileEntry?: Answer<string>;
  manifest?: Answer<Buffer | "absent" | "unavailable">;
  /** Member hex to its check answer; a member not held answers `matches`. */
  checks?: Record<string, Answer<string>>;
  kinds?: Partial<Record<"package" | "members", Answer<string>>>;
  listings?: Partial<Record<"package" | "members", Answer<PackageDirEntry[]>>>;
  memberBytes?: Answer<Buffer | "absent" | "unavailable">;
}

const leafRead = (held: Buffer | "absent" | "unavailable") => typeof held === "string" ? { kind: held } : { kind: "ok" as const, body: held };

/** The binding and private-directory looks, each logged as `binding.<call>`. */
function bindingOf(held: Held, note: (call: string) => void): ActiveBindingReads {
  return {
    readBindingLeaf: async (maxBytes) => { note(`binding.readBindingLeaf max=${maxBytes}`); return leafRead(serve(held.leaf ?? "absent")); },
    privateAliasHasNoEntries: async (names) => { note(`binding.privateAliasHasNoEntries ${names.join(",")}`); return serve(held.alias ?? false); },
    resolvePrivateDir: async () => { note("binding.resolvePrivateDir"); return serve(held.privateDir === undefined ? "mem:private" : held.privateDir); },
    privateEntryKind: async (dir, name) => { note(`binding.privateEntryKind ${dir}/${name}`); return serve(held.profileEntry ?? new Error("ENOENT")); },
  } as ActiveBindingReads;
}

/** The installed-package looks, each logged as `packages.<call>`. */
function packagesOf(held: Held, note: (call: string) => void): ProductPackageReads {
  const declared = { package: [file("manifest.json"), { name: "members", isFile: false, isDirectory: true }], members: MEMBERS.map(file) };
  return {
    readManifestLeaf: async (hex, maxBytes) => { note(`packages.readManifestLeaf ${hex === HEX ? "PKG" : hex} max=${maxBytes}`); return leafRead(serve(held.manifest ?? Buffer.from(PRODUCT.manifestText))); },
    checkMemberLeaf: async (_hex, memberHex, byteCount) => { note(`packages.checkMemberLeaf ${MEMBERS.indexOf(memberHex)} bytes=${byteCount}`); return serve(held.checks?.[memberHex] ?? "matches"); },
    directoryKind: async (_hex, directory) => { note(`packages.directoryKind ${directory}`); return serve(held.kinds?.[directory] ?? "directory"); },
    listDirectory: async (_hex, directory) => { note(`packages.listDirectory ${directory}`); return serve(held.listings?.[directory] ?? declared[directory]); },
    readMemberLeaf: async (_hex, memberHex, maxBytes) => { note(`packages.readMemberLeaf ${memberHex === KNOWLEDGE ? "KNOWLEDGE" : memberHex} max=${maxBytes}`); return leafRead(serve(held.memberBytes ?? PRODUCT.bytesByHex.get(memberHex)!)); },
  } as ProductPackageReads;
}

/** Sources held in memory, with the complete call log of both groups. */
function sourcesOf(held: Held = {}): { sources: ActiveProductSources; calls: string[] } {
  const calls: string[] = [];
  const note = (call: string): void => { calls.push(call); };
  return { sources: { root: ROOT, binding: bindingOf(held, note), packages: packagesOf(held, note) }, calls };
}

const BOUND = Buffer.from(serializeBinding(bindingFor(PRODUCT.manifest)));
const LEAF = `binding.readBindingLeaf max=${MAX_ACTIVE_PRODUCT_BINDING_BYTES}`;
const PRESENCE = ["binding.resolvePrivateDir", "binding.privateEntryKind mem:private/profile.json"];
const MANIFEST = `packages.readManifestLeaf PKG max=${MAX_PRODUCT_MANIFEST_BYTES}`;
const CHECKS = PRODUCT.manifest.members.map((member, index) => `packages.checkMemberLeaf ${index} bytes=${member.byteCount}`);
const LISTINGS = ["packages.directoryKind package", "packages.listDirectory package", "packages.directoryKind members", "packages.listDirectory members"];
const PACKAGE_OK = [MANIFEST, ...CHECKS, ...LISTINGS];
const MEMBER_READ = `packages.readMemberLeaf KNOWLEDGE max=${MAX_KNOWLEDGE_PROFILE_BYTES}`;
const read = (held: Held, digest: Sha256Digest = PRODUCT.manifest.packageDigest) => {
  const { sources, calls } = sourcesOf(held);
  return readInstalledProductPackageFrom(sources.packages, digest).then((result) => ({ result, calls }));
};

describe("the installed-package read over its sources", () => {
  it("K1 makes no read at all for a malformed package digest", async () => {
    expect(await read({}, "not-a-digest" as Sha256Digest)).toEqual({ result: { status: "unavailable", detail: "digest" }, calls: [] });
  });

  it("K2 reads the manifest, checks every member in manifest order, then looks at and lists the two directories", async () => {
    const { result, calls } = await read({});
    expect([result.status, calls]).toEqual(["ok", PACKAGE_OK]);
    expect(CHECKS.length).toBeGreaterThan(1);
  });

  it.each([
    ["absent", "absent", { status: "absent" }], ["unavailable", "unavailable", { status: "unavailable", detail: "manifest-leaf" }],
    ["not canonical", Buffer.from(`${PRODUCT.manifestText} `), { status: "invalid", detail: "stored manifest is not canonical" }],
    ["another package's", Buffer.from(buildProductPackage({ productVersion: "9.9.9" }).manifestText), { status: "invalid", detail: "package directory does not match its manifest digest" }],
  ] as const)("K3 stops at a manifest leaf that is %s, checking no member", async (_label, manifest, expected) => {
    expect(await read({ manifest })).toEqual({ result: expected, calls: [MANIFEST] });
  });

  it.each([
    ["absent", { status: "invalid", detail: "member-absent" }], ["unavailable", { status: "unavailable", detail: "member-leaf" }],
    ["differs", { status: "invalid", detail: "member-bytes" }],
  ] as const)("K4 stops at the first member that answers %s: no later member, no directory look", async (answer, expected) => {
    expect(await read({ checks: { [MEMBERS[1]!]: answer } })).toEqual({ result: expected, calls: [MANIFEST, ...CHECKS.slice(0, 2)] });
  });

  it("K5 classifies the three directory failures here, and never looks at the members directory after a bad package directory", async () => {
    const refused = new Error("EACCES: refused");
    const outcomes = [
      await read({ kinds: { package: refused } }), await read({ kinds: { package: "link" } }), await read({ listings: { package: refused } }),
      await read({ listings: { package: [file("manifest.json"), file("surprise.txt")] } }),
    ];
    expect(outcomes.map(({ result }) => result)).toEqual([
      { status: "unavailable", detail: "dir-absent" }, { status: "unavailable", detail: "dir-not-real" },
      { status: "unavailable", detail: "dir-unreadable" }, { status: "invalid", detail: "undeclared-package-leaf" },
    ]);
    expect(outcomes.map(({ calls }) => calls.slice(PACKAGE_OK.length - 4))).toEqual([LISTINGS.slice(0, 1), LISTINGS.slice(0, 1), LISTINGS.slice(0, 2), LISTINGS.slice(0, 2)]);
  });

  it("K6 refuses an undeclared member entry, and a member entry that is not a file", async () => {
    const extra = await read({ listings: { members: [...MEMBERS.map(file), file("b".repeat(64))] } });
    const notFile = await read({ listings: { members: MEMBERS.map((name) => ({ name, isFile: false, isDirectory: true })) } });
    expect([extra.result, notFile.result, extra.calls]).toEqual([
      { status: "invalid", detail: "undeclared-member-leaf" }, { status: "invalid", detail: "undeclared-member-leaf" }, PACKAGE_OK,
    ]);
  });

  it("K7 rejects with a manifest read's own error object", async () => {
    const refused = new Error("EIO: manifest read refused");
    const { sources, calls } = sourcesOf({ manifest: refused });
    await expect(readInstalledProductPackageFrom(sources.packages, PRODUCT.manifest.packageDigest)).rejects.toBe(refused);
    expect(calls).toEqual([MANIFEST]);
  });
});

describe("active-product resolution over its sources", () => {
  const resolve = async (held: Held) => { const { sources, calls } = sourcesOf(held); return { resolution: await resolveActiveProductFrom(sources), calls }; };

  it("R1 answers legacy for an absent binding leaf with that one call", async () => {
    expect(await resolve({})).toEqual({ resolution: { mode: "legacy" }, calls: [LEAF] });
  });

  it("R2 asks the alias check only after an unavailable read, by the binding's own name, and takes a rejecting check as no", async () => {
    const ALIAS = "binding.privateAliasHasNoEntries active-product.json";
    const unsafe = { mode: "unavailable", detail: "unsafe-leaf" };
    expect(await resolve({ leaf: "unavailable", alias: true })).toEqual({ resolution: { mode: "legacy" }, calls: [LEAF, ALIAS] });
    expect(await resolve({ leaf: "unavailable", alias: false })).toEqual({ resolution: unsafe, calls: [LEAF, ALIAS] });
    expect(await resolve({ leaf: "unavailable", alias: new Error("alias check refused") })).toEqual({ resolution: unsafe, calls: [LEAF, ALIAS] });
  });

  it("R3 answers unavailable for a leaf that does not parse, asking nothing else", async () => {
    const { resolution, calls } = await resolve({ leaf: Buffer.from("}{ not json") });
    expect([resolution.mode, calls]).toEqual(["unavailable", [LEAF]]);
  });

  it.each(["file", "link", "directory", "other"])("R4 answers conflict for a profile.json that is a %s, making no package call", async (profileEntry) => {
    expect(await resolve({ leaf: BOUND, profileEntry })).toEqual({ resolution: { mode: "conflict" }, calls: [LEAF, ...PRESENCE] });
  });

  it("R5 takes a private directory that cannot be resolved, none at all, and a look that fails each as no conflict, and goes on to the package", async () => {
    const refused = await resolve({ leaf: BOUND, privateDir: new Error("confinement refused") });
    const none = await resolve({ leaf: BOUND, privateDir: null });
    const lookFails = await resolve({ leaf: BOUND });
    expect([refused.resolution.mode, none.resolution.mode, lookFails.resolution.mode]).toEqual(["product", "product", "product"]);
    expect([refused.calls, none.calls]).toEqual([[LEAF, PRESENCE[0], ...PACKAGE_OK, MEMBER_READ], [LEAF, PRESENCE[0], ...PACKAGE_OK, MEMBER_READ]]);
    expect(lookFails.calls).toEqual([LEAF, ...PRESENCE, ...PACKAGE_OK, MEMBER_READ]);
  });

  it("R6 resolves product mode with the member path built from the one root, and loadProfileFrom returns that profile", async () => {
    const { sources, calls } = sourcesOf({ leaf: BOUND });
    const loadedFrom = knowledgeProfileMemberPath(ROOT, PRODUCT.manifest.packageDigest, PRODUCT.manifest.knowledgeProfile.digest);
    const strict = async (): Promise<never> => { throw new Error("legacy leaf read reached"); };
    const loaded = await loadProfileFrom({ activeProduct: sources, readPrivateLeafText: strict });
    expect([loaded.profile.profileId, loaded.loadedFrom, loadedFrom.startsWith(`${ROOT}${path.sep}`)]).toEqual(["custom", loadedFrom, true]);
    expect(calls).toEqual([LEAF, ...PRESENCE, ...PACKAGE_OK, MEMBER_READ]);
  });

  it("R7 answers unavailable for a component mismatch without reading the member, and for a package that is not ok", async () => {
    const forged = Buffer.from(serializeBinding(bindingFor(PRODUCT.manifest, { knowledgeProfileDigest: `sha256:${"b".repeat(64)}` as Sha256Digest })));
    const mismatch = await resolve({ leaf: forged });
    expect(mismatch).toEqual({ resolution: { mode: "unavailable", detail: "component-mismatch:knowledgeProfileDigest" }, calls: [LEAF, ...PRESENCE, ...PACKAGE_OK] });
    expect((await resolve({ leaf: BOUND, manifest: "absent" })).resolution).toEqual({ mode: "unavailable", detail: "package-absent" });
  });

  it("R8 lets a package read that rejects leave as the same error, but turns a failed member load into unavailable", async () => {
    const refused = new Error("EIO: package read refused");
    await expect(resolveActiveProductFrom(sourcesOf({ leaf: BOUND, manifest: refused }).sources)).rejects.toBe(refused);
    const member = await resolve({ leaf: BOUND, memberBytes: "unavailable" });
    expect([member.resolution.mode, member.calls.at(-1)]).toEqual(["unavailable", MEMBER_READ]);
    const thrown = await resolve({ leaf: BOUND, memberBytes: new Error("EIO: member read refused") });
    expect(thrown.resolution).toEqual({ mode: "unavailable", detail: "EIO: member read refused" });
  });
});
