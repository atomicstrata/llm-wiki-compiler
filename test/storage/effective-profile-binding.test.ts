/**
 * @file test/storage/effective-profile-binding.test.ts
 * @description The effective-profile loader over its sources. This file uses
 * `loadProfileFrom` and `loadNonDefaultProfileFrom`, which exist only after the
 * loader was given sources to read through, so it has NO before-edit run.
 *
 * There is no project directory. The doubles decide nothing: `binding` (the
 * binding leaf, the alias check, the private-directory resolution, a look at
 * one entry) and `profile` (the legacy profile leaf). The `packages` double has
 * no methods at all: any call to it would throw, and none of these cases
 * reaches product mode (`active-product-sources.test.ts` covers that).
 *
 * WHAT IS LOGGED. Every method of the doubles logs to ONE shared, ordered log
 * BEFORE it returns or throws, with its group (`binding.` or `profile.`) and
 * the cap it was passed.
 *
 * The production loader runs on what they serve: legacy when there is no
 * binding; missing is the built-in default; a link, another open failure and an
 * oversize leaf are each the named error; a failed read rejects with the same
 * object; a confinement fault outranks unavailable; the `loadedFrom` path is
 * built from the one root; and the non-default gate.
 *
 * NOT SHOWN HERE: how the local disk resolves the private directory or opens a
 * leaf without following a link. `effective-profile-reads.test.ts`,
 * `profile-loader-confined.test.ts` and `profile-viewer-legacy.test.ts` show
 * that on real files.
 *
 * The doubles are not a hosted store, not an access-control layer and not
 * `ProjectStore`.
 */

import { describe, expect, it } from "bun:test";
import { loadNonDefaultProfileFrom } from "../../src/profile/block.js";
import { DEFAULT_PROFILE } from "../../src/profile/default.js";
import { profileDigest } from "../../src/profile/digest.js";
import { loadProfileFrom, ProfileLoadError, type EffectiveProfileSources } from "../../src/profile/load.js";
import { ActiveProductUnavailableError, ProductAuthorityConflictError } from "../../src/products/binding/problems.js";
import type { ActiveBindingReads } from "../../src/products/binding/store.js";
import { MAX_ACTIVE_PRODUCT_BINDING_BYTES } from "../../src/products/binding/types.js";
import type { ProductPackageReads } from "../../src/products/packages/store.js";
import type { CappedTextNoFollowRead } from "../../src/storage/disk-handle-leaves.js";
import { PROFILE_FILE } from "../../src/utils/constants.js";
import { PrivateDirConfinementError } from "../../src/utils/private-dir.js";
import { bindingFor, buildProfileOnlyProduct, serializeBinding } from "../products/binding-fixture.js";

const ROOT = "/display/only/project";
const LOGICAL = `${ROOT}/${PROFILE_FILE}`;
const VALID = { schemaVersion: 1, profileId: "legacy", displayName: "Legacy", entities: { notes: { directory: "wiki/notes" } } };
const coded = (code: string, message: string): Error => Object.assign(new Error(message), { code });

interface Held {
  /** The binding leaf's answer; the default is `absent`, which is legacy mode. */
  leaf?: "absent" | "unavailable" | Buffer;
  /** The private directory: a token, `null` for none, or an `Error` the resolution rejects with. */
  privateDir?: string | null | Error;
  /** A present `profile.json` entry beside a binding (any kind is a conflict). */
  profileEntry?: string;
  /** The legacy profile leaf's answer, or an `Error` the read rejects with. */
  profileLeaf?: CappedTextNoFollowRead | Error;
}

/** Sources held in memory, with the complete call log of every group. */
function sourcesOf(held: Held = {}): { sources: EffectiveProfileSources; calls: string[] } {
  const calls: string[] = [];
  const dir = held.privateDir === undefined ? "mem:private" : held.privateDir;
  const leaf = held.leaf ?? "absent";
  const binding = {
    readBindingLeaf: async (maxBytes: number) => { calls.push(`binding.readBindingLeaf max=${maxBytes}`); return typeof leaf === "string" ? { kind: leaf } : { kind: "ok", body: leaf }; },
    privateAliasHasNoEntries: async (names: readonly string[]) => { calls.push(`binding.privateAliasHasNoEntries ${names.join(",")}`); return false; },
    resolvePrivateDir: async () => { calls.push("binding.resolvePrivateDir"); if (dir instanceof Error) throw dir; return dir; },
    privateEntryKind: async (where: string, name: string) => { calls.push(`binding.privateEntryKind ${where}/${name}`); if (held.profileEntry === undefined) throw coded("ENOENT", "no entry"); return held.profileEntry; },
  } as unknown as ActiveBindingReads;
  const readPrivateLeafText = async (where: string, name: string, maxBytes: number): Promise<CappedTextNoFollowRead> => {
    calls.push(`profile.readPrivateLeafText ${where}/${name} max=${maxBytes}`);
    const answer = held.profileLeaf ?? { kind: "not-opened", error: coded("ENOENT", "no profile") };
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { sources: { activeProduct: { root: ROOT, binding, packages: {} as ProductPackageReads }, readPrivateLeafText }, calls };
}

const LEAF = `binding.readBindingLeaf max=${MAX_ACTIVE_PRODUCT_BINDING_BYTES}`;
const ALIAS = "binding.privateAliasHasNoEntries active-product.json";
const RESOLVE = "binding.resolvePrivateDir";
const PROFILE_READ = "profile.readPrivateLeafText mem:private/profile.json max=1048576";
const text = (body: string): Held => ({ profileLeaf: { kind: "text", text: body } });
const failure = (held: Held): Promise<unknown> => loadProfileFrom(sourcesOf(held).sources).then(() => "resolved", (error: unknown) => error);

describe("the effective profile over its sources, legacy mode", () => {
  it("E1 answers the built-in default when there is no private directory, reading no leaf", async () => {
    const { sources, calls } = sourcesOf({ privateDir: null });
    expect(await loadProfileFrom(sources)).toEqual({ profile: DEFAULT_PROFILE, loadedFrom: null, digest: profileDigest(DEFAULT_PROFILE) });
    expect(await loadNonDefaultProfileFrom(sources)).toBeUndefined();
    expect(calls).toEqual([LEAF, RESOLVE, LEAF, RESOLVE]);
  });

  it("E2 loads a present profile, reports the logical path under the one root, and passes the gate", async () => {
    const { sources, calls } = sourcesOf(text(JSON.stringify(VALID)));
    const loaded = await loadProfileFrom(sources);
    expect([loaded.profile.profileId, loaded.loadedFrom, loaded.digest]).toEqual(["legacy", LOGICAL, profileDigest(VALID as never)]);
    expect(calls).toEqual([LEAF, RESOLVE, PROFILE_READ]);
    expect((await loadNonDefaultProfileFrom(sources))?.loadedFrom).toBe(LOGICAL);
  });

  it("E3 takes only a missing leaf as the default; a link, another open failure and an oversize leaf are each the named error", async () => {
    const open = (error: Error): Held => ({ profileLeaf: { kind: "not-opened", error } });
    expect((await loadProfileFrom(sourcesOf(open(coded("ENOENT", "gone"))).sources)).loadedFrom).toBeNull();
    expect(await failure(open(coded("ELOOP", "link")))).toEqual(new ProfileLoadError(`${PROFILE_FILE} is a symlink — refusing to follow`));
    expect(await failure(open(coded("EACCES", "open refused")))).toEqual(new ProfileLoadError(`Failed to read ${PROFILE_FILE}: open refused`));
    expect(await failure({ profileLeaf: { kind: "oversize", size: 1048577 } }))
      .toEqual(new ProfileLoadError(`${PROFILE_FILE} is 1048577 bytes — exceeds the 1048576-byte cap`));
  });

  it("E4 rejects with a failed read's own error object, and names the logical path for text that is not JSON", async () => {
    const refused = coded("EIO", "read refused");
    await expect(loadProfileFrom(sourcesOf({ profileLeaf: refused }).sources)).rejects.toBe(refused);
    const broken = await failure(text("{ not json"));
    expect(broken).toBeInstanceOf(ProfileLoadError);
    expect((broken as Error).message.startsWith(`Invalid JSON in ${LOGICAL}: `)).toBe(true);
  });

  it("E5 turns a confinement fault on the private directory into its own error, and lets any other failure leave raw", async () => {
    const raw = coded("EIO", "resolution refused");
    expect(await failure({ privateDir: new PrivateDirConfinementError("escapes") }))
      .toEqual(new ProfileLoadError(`${PROFILE_FILE} directory is a symlink — refusing to follow`));
    await expect(loadProfileFrom(sourcesOf({ privateDir: raw }).sources)).rejects.toBe(raw);
  });
});

describe("the effective profile over its sources, with a binding leaf", () => {
  const BINDING_LIKE = Buffer.from("}{ not a binding");

  it("E6 never falls back for an unavailable binding: it resolves the private directory once more, then throws unavailable", async () => {
    const { sources, calls } = sourcesOf({ leaf: "unavailable", ...text(JSON.stringify(VALID)) });
    await expect(loadProfileFrom(sources)).rejects.toEqual(new ActiveProductUnavailableError("unsafe-leaf"));
    expect(calls).toEqual([LEAF, ALIAS, RESOLVE]);
    const malformed = sourcesOf({ leaf: BINDING_LIKE, ...text(JSON.stringify(VALID)) });
    await expect(loadProfileFrom(malformed.sources)).rejects.toBeInstanceOf(ActiveProductUnavailableError);
    expect(malformed.calls).toEqual([LEAF, RESOLVE]);
  });

  it("E7 lets a confinement fault outrank unavailable, and another resolution failure leave raw", async () => {
    const raw = coded("EIO", "resolution refused");
    expect(await failure({ leaf: "unavailable", privateDir: new PrivateDirConfinementError("escapes") }))
      .toEqual(new ProfileLoadError(`${PROFILE_FILE} directory is a symlink — refusing to follow`));
    await expect(loadProfileFrom(sourcesOf({ leaf: "unavailable", privateDir: raw }).sources)).rejects.toBe(raw);
  });

  it("E8 throws the conflict error for a parseable binding beside a profile.json, reading neither the leaf nor the package", async () => {
    const leaf = Buffer.from(serializeBinding(bindingFor(buildProfileOnlyProduct().manifest)));
    const { sources, calls } = sourcesOf({ leaf, profileEntry: "file", ...text(JSON.stringify(VALID)) });
    await expect(loadProfileFrom(sources)).rejects.toBeInstanceOf(ProductAuthorityConflictError);
    expect(calls).toEqual([LEAF, RESOLVE, "binding.privateEntryKind mem:private/profile.json"]);
  });
});
