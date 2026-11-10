/**
 * @file test/storage/preparation-readiness-binding.test.ts
 * @description The four preparation READINESS bodies run from memory:
 * `resolveHostReadinessFrom`, `resolvePreparationReadReadinessFrom`,
 * `preparationResetPreflightRefusalFrom` and `preparationPreflightRefusalFrom`.
 * What is pinned is their own decisions: presence, then profile, then key, each
 * read at most once; every refusal's exact words; which failed store look means
 * not-there and which means could-not-tell; that a failing look is CLASSIFIED
 * and never propagates; the write path's deliberate collapse of every probe
 * failure into one refusal; that an absent key is ready; and that reset's
 * preflight never reads the key. Two cases pin what the bodies do NOT do: a
 * probe or a profile load that throws synchronously, against the reads'
 * contract, is not turned into a refusal and leaves the body as a rejection.
 *
 * WHAT KIND OF TEST THIS IS. There is no project directory and nothing is
 * written anywhere. The reads are scripted per case and log every call, so a
 * case can assert what was asked and in what order. The last block replaces
 * two scripted members with REAL bodies: the profile is loaded by the real
 * effective-profile loader over in-memory sources, and the key is read by the
 * real key body over an in-memory key leaf.
 *
 * WHAT THIS IS NOT. A scripted store look is not a `stat`, and a scripted probe
 * is not an `access`: this is NOT evidence of what the local disk reports for a
 * missing, unreadable or non-directory store, of profile confinement, or of
 * key-file health. `readiness-disk-witness.test.ts` shows the disk answers.
 * Readiness is not an authority boundary and nothing here makes it one. The
 * key text below is a fixed test pattern, never a real key. Nothing here
 * selects a backend.
 */

import { describe, expect, it } from "bun:test";
import { readPreparationKeyFrom, type PreparationKeyRead } from "../../src/preparations/key-epoch.js";
import { preparationKeyEpochId } from "../../src/preparations/run-integrity.js";
import {
  preparationPreflightRefusalFrom, preparationResetPreflightRefusalFrom, resolveHostReadinessFrom,
  resolvePreparationReadReadinessFrom, type PreparationReadinessReads,
} from "../../src/preparations/service-readiness.js";
import { loadProfileFrom, type EffectiveProfileSources } from "../../src/profile/load.js";
import { MAX_ACTIVE_PRODUCT_BINDING_BYTES } from "../../src/products/binding/types.js";
import type { CappedTextNoFollowRead } from "../../src/storage/disk-handle-leaves.js";
import { MAX_PROFILE_BYTES } from "../../src/utils/constants.js";
import { noBindingLeafDouble } from "../fixtures/no-binding-leaf-double.js";

const KEY_BYTES = 32;
/** A fixed test pattern. Not a real key. */
const KEY = Buffer.alloc(KEY_BYTES, 5);
const KEY_TEXT = KEY.toString("base64");
const OK_KEY: PreparationKeyRead = { status: "ok", key: KEY, keyEpochId: preparationKeyEpochId(KEY) };
const STORE_MISSING = "no .llmwiki store here; run from the project root";
const STORE_NOT_A_DIRECTORY = ".llmwiki exists here but is not a directory";
const SECOND_STORE = "no .llmwiki store here; run from the project root rather than creating a second store";
const PROFILE_BROKEN = "the project profile is present but unreadable; preparation commands cannot proceed";
const KEY_UNREADABLE = "the preparation key is unreadable; preparation commands cannot proceed";
const READY = { ready: true, reason: null };
/** A provider defect: thrown synchronously by a read that was required to return a promise. */
const DEFECT = new Error("a read threw synchronously instead of returning a promise");

/** An error carrying a Node-style `code`. */
function coded(code: string): Error {
  return Object.assign(new Error(`scripted ${code}`), { code });
}

/** What a case scripts for the four reads. Every omitted answer is the healthy one. */
interface ReadsScript {
  /** The store look's answer, or the error it REJECTS with. */
  store?: "directory" | "not-directory" | Error;
  /** When set, the store look THROWS it synchronously instead. */
  storeThrows?: Error;
  /** The error the write-path probe rejects with; it resolves when omitted. */
  probe?: Error;
  /** The error the profile load rejects with; it loads when omitted. */
  profile?: Error;
  /** The key read's answer. */
  key?: PreparationKeyRead;
}

/** The four reads over `script`, each logging its name before it answers. */
function readsOf(script: ReadsScript, log: string[] = []): PreparationReadinessReads {
  return {
    observeStore: () => {
      log.push("store");
      if (script.storeThrows !== undefined) throw script.storeThrows;
      return script.store instanceof Error ? Promise.reject(script.store) : Promise.resolve(script.store ?? "directory");
    },
    probeStore: () => {
      log.push("probe");
      return script.probe === undefined ? Promise.resolve() : Promise.reject(script.probe);
    },
    loadProfile: () => {
      log.push("profile");
      return script.profile === undefined ? Promise.resolve({ loaded: true }) : Promise.reject(script.profile);
    },
    readKey: async () => {
      log.push("key");
      return script.key ?? OK_KEY;
    },
  };
}

/** One body's answer over `script`, with the names of the reads it made, in order. */
async function asked<T>(body: (reads: PreparationReadinessReads) => Promise<T>, script: ReadsScript): Promise<[T, string[]]> {
  const log: string[] = [];
  return [await body(readsOf(script, log)), log];
}

describe("read readiness from memory: the store look", () => {
  it("D1 a directory, a loading profile and a readable key are ready: store, then profile, then key", async () => {
    expect(await asked(resolvePreparationReadReadinessFrom, {})).toEqual([{ status: "ready" }, ["store", "profile", "key"]]);
  });

  it("D2 something that is not a directory is absent, in its own words, and nothing else is read", async () => {
    expect(await asked(resolvePreparationReadReadinessFrom, { store: "not-directory" }))
      .toEqual([{ status: "absent", detail: STORE_NOT_A_DIRECTORY }, ["store"]]);
  });

  it("D3 a look that fails with ENOENT or ENOTDIR is absent, and nothing else is read", async () => {
    for (const code of ["ENOENT", "ENOTDIR"]) {
      expect(await asked(resolvePreparationReadReadinessFrom, { store: coded(code) }))
        .toEqual([{ status: "absent", detail: STORE_MISSING }, ["store"]]);
    }
  });

  it("D4 a look that fails any other way is unreadable and names the code; a look with no code says unknown error", async () => {
    expect(await asked(resolvePreparationReadReadinessFrom, { store: coded("EACCES") }))
      .toEqual([{ status: "unreadable", detail: "the .llmwiki store could not be read (EACCES)" }, ["store"]]);
    expect(await asked(resolvePreparationReadReadinessFrom, { store: new Error("no code at all") }))
      .toEqual([{ status: "unreadable", detail: "the .llmwiki store could not be read (unknown error)" }, ["store"]]);
  });

  it("D5 a look that THROWS instead of rejecting is classified the same way, not propagated", async () => {
    expect(await asked(resolvePreparationReadReadinessFrom, { storeThrows: coded("EIO") }))
      .toEqual([{ status: "unreadable", detail: "the .llmwiki store could not be read (EIO)" }, ["store"]]);
    expect(await asked(resolvePreparationReadReadinessFrom, { storeThrows: coded("ENOENT") }))
      .toEqual([{ status: "absent", detail: STORE_MISSING }, ["store"]]);
  });
});

describe("read readiness from memory: a present store that cannot be acted in", () => {
  it("D6 a broken profile is unreadable, never absent, and the key is not read", async () => {
    expect(await asked(resolvePreparationReadReadinessFrom, { profile: new Error("broken") }))
      .toEqual([{ status: "unreadable", detail: PROFILE_BROKEN }, ["store", "profile"]]);
  });

  it("D7 an unreadable key is unreadable; an absent key is ready", async () => {
    expect(await asked(resolvePreparationReadReadinessFrom, { key: { status: "unavailable" } }))
      .toEqual([{ status: "unreadable", detail: KEY_UNREADABLE }, ["store", "profile", "key"]]);
    expect((await asked(resolvePreparationReadReadinessFrom, { key: { status: "absent" } }))[0]).toEqual({ status: "ready" });
  });
});

describe("host readiness from memory: profile, then key, and never the store", () => {
  it("H1 a broken profile is not ready, and the key is not read", async () => {
    expect(await asked(resolveHostReadinessFrom, { profile: new Error("broken") }))
      .toEqual([{ ready: false, reason: PROFILE_BROKEN }, ["profile"]]);
  });

  it("H2 an unreadable key is not ready; an absent key and a readable key are both ready", async () => {
    expect(await asked(resolveHostReadinessFrom, { key: { status: "unavailable" } }))
      .toEqual([{ ready: false, reason: KEY_UNREADABLE }, ["profile", "key"]]);
    expect(await asked(resolveHostReadinessFrom, { key: { status: "absent" } })).toEqual([READY, ["profile", "key"]]);
    expect(await asked(resolveHostReadinessFrom, {})).toEqual([READY, ["profile", "key"]]);
  });

  it("H3 CONTRACT BREACH: a profile load that THROWS synchronously is not turned into a refusal; host readiness rejects with the same object", async () => {
    const reads: PreparationReadinessReads = { ...readsOf({}), loadProfile: () => { throw DEFECT; } };
    await expect(resolveHostReadinessFrom(reads)).rejects.toBe(DEFECT);
  });
});

describe("the write preflight from memory: probe, then profile, then key", () => {
  it("F1 a probe that rejects, for any reason, is the one second-store refusal, and nothing else is read", async () => {
    for (const failure of [coded("ENOENT"), coded("EACCES"), new Error("no code at all")]) {
      expect(await asked(preparationPreflightRefusalFrom, { probe: failure })).toEqual([SECOND_STORE, ["probe"]]);
    }
  });

  it("F2 a broken profile refuses in the profile's words, and the key is not read", async () => {
    expect(await asked(preparationPreflightRefusalFrom, { profile: new Error("broken") }))
      .toEqual([PROFILE_BROKEN, ["probe", "profile"]]);
  });

  it("F3 an unreadable key refuses in the key's words; an absent key and a readable key pass", async () => {
    expect(await asked(preparationPreflightRefusalFrom, { key: { status: "unavailable" } }))
      .toEqual([KEY_UNREADABLE, ["probe", "profile", "key"]]);
    expect(await asked(preparationPreflightRefusalFrom, { key: { status: "absent" } })).toEqual([null, ["probe", "profile", "key"]]);
    expect(await asked(preparationPreflightRefusalFrom, {})).toEqual([null, ["probe", "profile", "key"]]);
  });

  it("F4 the write path never makes the read path's store look", async () => {
    const [, log] = await asked(preparationPreflightRefusalFrom, { store: coded("EACCES") });
    expect(log).not.toContain("store");
  });

  it("F5 CONTRACT BREACH: a probe that THROWS synchronously is not collapsed; both write preflights reject with the same object", async () => {
    const reads: PreparationReadinessReads = { ...readsOf({}), probeStore: () => { throw DEFECT; } };
    await expect(preparationPreflightRefusalFrom(reads)).rejects.toBe(DEFECT);
    await expect(preparationResetPreflightRefusalFrom(reads)).rejects.toBe(DEFECT);
  });
});

describe("the reset preflight from memory: probe, then profile, and NEVER the key", () => {
  it("X1 an unreadable key does not refuse a reset, because the key is never read", async () => {
    expect(await asked(preparationResetPreflightRefusalFrom, { key: { status: "unavailable" } }))
      .toEqual([null, ["probe", "profile"]]);
  });

  it("X2 a rejecting probe and a broken profile refuse a reset in the same words as the write preflight", async () => {
    expect(await asked(preparationResetPreflightRefusalFrom, { probe: coded("EACCES") })).toEqual([SECOND_STORE, ["probe"]]);
    expect(await asked(preparationResetPreflightRefusalFrom, { profile: new Error("broken") }))
      .toEqual([PROFILE_BROKEN, ["probe", "profile"]]);
  });
});

const NO_PROFILE_LEAF: CappedTextNoFollowRead = { kind: "not-opened", error: coded("ENOENT") };
const BINDING_CALLS = [`binding.readBindingLeaf max=${MAX_ACTIVE_PRODUCT_BINDING_BYTES}`, "binding.resolvePrivateDir"];

/** Legacy-profile sources held in memory: no binding leaf, and `leaf` as the profile leaf's answer. */
function profileSourcesOf(leaf: CappedTextNoFollowRead, note: (call: string) => void): EffectiveProfileSources {
  return {
    activeProduct: { root: "/shown/never/opened", binding: noBindingLeafDouble(note), packages: {} } as unknown as EffectiveProfileSources["activeProduct"],
    readPrivateLeafText: async (where, leafName, cap) => {
      note(`profile-leaf ${where}/${leafName} cap=${cap}`);
      return leaf;
    },
  };
}

/** Readiness reads whose profile and key members run the REAL bodies over memory. */
function coupledReads(profileLeaf: CappedTextNoFollowRead, keyText: string, log: string[]): PreparationReadinessReads {
  const note = (call: string): void => { log.push(call); };
  return {
    ...readsOf({}, log),
    loadProfile: () => loadProfileFrom(profileSourcesOf(profileLeaf, note)),
    readKey: () => readPreparationKeyFrom({ readKeyLeaf: async () => { note("key-leaf"); return { kind: "ok", body: keyText }; } }),
  };
}

describe("readiness coupled to the real profile loader and the real key body", () => {
  it("C1 the built-in default profile and a canonical key are ready, read in order through both real bodies", async () => {
    const log: string[] = [];
    expect(await resolvePreparationReadReadinessFrom(coupledReads(NO_PROFILE_LEAF, KEY_TEXT, log))).toEqual({ status: "ready" });
    expect(log).toEqual(["store", ...BINDING_CALLS, `profile-leaf mem:private/profile.json cap=${MAX_PROFILE_BYTES}`, "key-leaf"]);
  });

  it("C2 profile text the real loader refuses makes every form answer in the profile's words, and the key leaf is never read", async () => {
    const log: string[] = [];
    const reads = coupledReads({ kind: "text", text: "{ not json" }, KEY_TEXT, log);
    expect(await resolveHostReadinessFrom(reads)).toEqual({ ready: false, reason: PROFILE_BROKEN });
    expect(await preparationPreflightRefusalFrom(reads)).toBe(PROFILE_BROKEN);
    expect(await preparationResetPreflightRefusalFrom(reads)).toBe(PROFILE_BROKEN);
    expect(log).not.toContain("key-leaf");
  });

  it("C3 key text the real key body refuses stops everything except a reset", async () => {
    const reads = coupledReads(NO_PROFILE_LEAF, `${KEY_TEXT}\n`, []);
    expect(await resolveHostReadinessFrom(reads)).toEqual({ ready: false, reason: KEY_UNREADABLE });
    expect(await resolvePreparationReadReadinessFrom(reads)).toEqual({ status: "unreadable", detail: KEY_UNREADABLE });
    expect(await preparationPreflightRefusalFrom(reads)).toBe(KEY_UNREADABLE);
    expect(await preparationResetPreflightRefusalFrom(reads)).toBeNull();
  });
});
