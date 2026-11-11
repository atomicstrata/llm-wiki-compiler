/**
 * @file test/storage/preparation-run-lookup-binding.test.ts
 * @description The preparation run lookup's REAL bodies, the four `…From`
 * functions of `service-run-lookup.ts`, run over an in-memory double of the
 * four reads they ask for. What is pinned is the lookup's own classification
 * and order: which miss a scan produces and in what precedence, that the key is
 * read before the run and the binding is built after it, which run and key
 * answers are `denied` and which `unavailable`, what the sealed-input read is
 * asked for, how its bytes are decoded, and that a read's rejection is not
 * caught.
 *
 * THE DOUBLE DECIDES NOTHING. Every read logs its arguments and returns the
 * answer the case scripted. It has no project root and touches no file.
 *
 * WHAT THIS IS NOT. It is NOT evidence of authentication, confinement or
 * digest verification. On disk the run read authenticates the leaf against the
 * preparation key, the key read refuses an unhealthy key file, and the evidence
 * read enforces its cap and checks the digest; the double does none of that and
 * answers `ok` for whatever it was given. Nothing here runs the local-disk
 * reads, which are private to the lookup, so nothing here observes them: that
 * the disk key read hands on the epoch and never the key bytes is read from the
 * source, not tested. The seam's key answer has no field for key bytes; that is
 * a fact about its TYPE, stated here and asserted by no case.
 *
 * The double is not a hosted store and selects no backend.
 */

import { describe, expect, it } from "bun:test";
import type { PreparationEvidenceBytesRead } from "../../src/preparations/evidence-store.js";
import { preparationManifestDigest, type PreparationManifestV1 } from "../../src/preparations/manifest-parse.js";
import type { PreparationInventoryProblem } from "../../src/preparations/orphan-scan.js";
import type { PreparationRunBinding, PreparationRunV1 } from "../../src/preparations/run-types.js";
import {
  locatePreparationManifestFrom, readPreparationInitialInputFrom, readPreparationRunForManifestFrom,
  resolvePreparationRunFrom, type PreparationRunLookupReads,
} from "../../src/preparations/service-run-lookup.js";
import { EPOCH, keyAndRunDoubles, type KeyAndRunScript } from "./preparation-key-run-doubles.js";

type KeyAnswer = Awaited<ReturnType<PreparationRunLookupReads["readKeyEpoch"]>>;

const INPUT_HEX = "b".repeat(64);
const INPUT_BYTE_CAP = 17;
const RUN = { state: "staged" } as unknown as PreparationRunV1;
const PROBLEM: PreparationInventoryProblem = { dimension: "manifest", detail: "unreadable" };
const BOOM = new Error("the read rejected");
const NON_OK_KEYS: readonly KeyAnswer[] = [{ status: "absent" }, { status: "unavailable" }];
const NON_OK_EVIDENCE: readonly PreparationEvidenceBytesRead[] = [
  { status: "absent" }, { status: "unavailable" }, { status: "over-cap" }, { status: "mismatch" },
];

/** What one case scripts; every field has a plain ok default. The key and run fields are the shared fixture's. */
interface Script extends KeyAndRunScript {
  manifests?: readonly PreparationManifestV1[];
  problems?: readonly PreparationInventoryProblem[];
  evidence?: PreparationEvidenceBytesRead;
}

/** A manifest carrying only the fields the lookup and the binding read. */
function manifestOf(runId: string): PreparationManifestV1 {
  return {
    runId, preparationId: `prp_${runId}`, workspaceId: "ws-one",
    plan: { initialInputSet: { digest: `sha256:${INPUT_HEX}`, byteCount: INPUT_BYTE_CAP } },
  } as unknown as PreparationManifestV1;
}

/** The binding the lookup must build for `manifest` as it is NOW. */
function bindingOf(manifest: PreparationManifestV1): PreparationRunBinding {
  return {
    runId: manifest.runId, preparationId: manifest.preparationId, workspaceId: manifest.workspaceId,
    manifestDigest: preparationManifestDigest(manifest), keyEpochId: EPOCH,
  };
}

/** The four reads over `script`, and the log of every call in order. */
function storeOf(script: Script = {}): { reads: PreparationRunLookupReads; log: unknown[][] } {
  const log: unknown[][] = [];
  const reads: PreparationRunLookupReads = {
    scanInventory: async () => {
      log.push(["scan"]);
      return { manifests: script.manifests ?? [], problems: script.problems ?? [] };
    },
    ...keyAndRunDoubles(log, script, RUN),
    readEvidenceBytes: async (location, digest, maxBytes) => {
      log.push(["evidence", location, digest, maxBytes]);
      return script.evidence ?? { status: "ok", bytes: Buffer.from(`{"slug":"probe"}`, "utf8") };
    },
  };
  return { reads, log };
}

/** Decode `text` as the sealed input, through the real body. */
function decode(text: string): ReturnType<typeof readPreparationInitialInputFrom> {
  const store = storeOf({ evidence: { status: "ok", bytes: Buffer.from(text, "utf8") } });
  return readPreparationInitialInputFrom(store.reads, manifestOf("prr_one"));
}

describe("run lookup over its own reads: locating a manifest", () => {
  it("L1 returns the manifest the scan holds, after exactly one scan", async () => {
    const manifest = manifestOf("prr_one");
    const store = storeOf({ manifests: [manifestOf("prr_other"), manifest] });
    const located = await locatePreparationManifestFrom(store.reads, "prr_one");
    expect(located).toEqual({ ok: true, manifest });
    expect(located.ok && located.manifest).toBe(manifest);
    expect(store.log).toEqual([["scan"]]);
  });

  it("L2 a scan with problems is unavailable, BEFORE the empty-store rule and the no-such-run rule", async () => {
    const miss = { ok: false, failure: "unavailable", reason: "the preparation scan was not authoritative; this run may exist" };
    for (const manifests of [[], [manifestOf("prr_other")]]) {
      const store = storeOf({ manifests, problems: [PROBLEM] });
      expect(await locatePreparationManifestFrom(store.reads, "prr_one")).toEqual(miss);
      expect(store.log).toEqual([["scan"]]);
    }
  });

  it("L2 a clean scan with no manifest at all is denied as not a preparation store", async () => {
    expect(await locatePreparationManifestFrom(storeOf().reads, "prr_one")).toEqual({
      ok: false, failure: "denied", reason: "no preparation store here; run from the project root",
    });
  });

  it("L2 a clean scan that holds other runs is denied as no such run", async () => {
    const store = storeOf({ manifests: [manifestOf("prr_other")] });
    expect(await locatePreparationManifestFrom(store.reads, "prr_one")).toEqual({
      ok: false, failure: "denied", reason: "no such preparation run",
    });
  });
});

describe("run lookup over its own reads: reading the run for a located manifest", () => {
  it("L3 reads the key, then the run, with a binding built from the manifest AFTER the key read", async () => {
    const manifest = manifestOf("prr_one");
    const digestBefore = preparationManifestDigest(manifest);
    const store = storeOf({ duringKeyRead: () => { (manifest as { workspaceId: string }).workspaceId = "ws-changed"; } });
    const result = await readPreparationRunForManifestFrom(store.reads, manifest);
    const binding = bindingOf(manifest);
    expect(binding.workspaceId).toBe("ws-changed");
    expect(binding.manifestDigest).not.toBe(digestBefore);
    expect(store.log).toEqual([["key"], ["run", binding]]);
    expect(result).toEqual({ ok: true, binding, run: RUN });
  });

  it("L4 an absent or unavailable key is unavailable, and no run is read", async () => {
    for (const key of NON_OK_KEYS) {
      const store = storeOf({ key });
      expect(await readPreparationRunForManifestFrom(store.reads, manifestOf("prr_one"))).toEqual({
        ok: false, failure: "unavailable", reason: `preparation key is ${key.status}`,
      });
      expect(store.log).toEqual([["key"]]);
    }
  });

  it("L5 an absent run leaf is denied", async () => {
    const store = storeOf({ run: { status: "absent" } });
    expect(await readPreparationRunForManifestFrom(store.reads, manifestOf("prr_one"))).toEqual({
      ok: false, failure: "denied", reason: "run is unreadable: absent",
    });
  });

  it("L5 an unavailable run leaf is unavailable, and the reason carries the code, not the detail", async () => {
    const store = storeOf({ run: { status: "unavailable", detail: "private detail", code: "run-integrity-invalid" } });
    expect(await readPreparationRunForManifestFrom(store.reads, manifestOf("prr_one"))).toEqual({
      ok: false, failure: "unavailable", reason: "run is unreadable: run-integrity-invalid",
    });
  });
});

describe("run lookup over its own reads: resolving a run by id", () => {
  it("L6 makes one scan, one key read and one run read, in that order", async () => {
    const manifest = manifestOf("prr_one");
    const store = storeOf({ manifests: [manifest] });
    const binding = bindingOf(manifest);
    expect(await resolvePreparationRunFrom(store.reads, "prr_one")).toEqual({ ok: true, binding, run: RUN });
    expect(store.log).toEqual([["scan"], ["key"], ["run", binding]]);
  });

  it("L6 a miss returns the scan's classification and reads no key and no run", async () => {
    const store = storeOf({ manifests: [manifestOf("prr_other")] });
    expect(await resolvePreparationRunFrom(store.reads, "prr_one")).toEqual({
      ok: false, failure: "denied", reason: "no such preparation run",
    });
    expect(store.log).toEqual([["scan"]]);
  });
});

describe("run lookup over its own reads: the sealed initial input", () => {
  it("L7 asks for the manifest's location, the digest without its prefix, and the plan's byte count as the cap", async () => {
    const store = storeOf();
    await readPreparationInitialInputFrom(store.reads, manifestOf("prr_one"));
    expect(store.log).toEqual([
      ["evidence", { workspaceId: "ws-one", preparationId: "prp_prr_one" }, INPUT_HEX, INPUT_BYTE_CAP],
    ]);
  });

  it("L8 each non-ok evidence status is reported by name", async () => {
    for (const evidence of NON_OK_EVIDENCE) {
      const store = storeOf({ evidence });
      expect(await readPreparationInitialInputFrom(store.reads, manifestOf("prr_one")))
        .toEqual({ ok: false, reason: `sealed input is ${evidence.status}` });
    }
  });

  it("L9 bytes that are not JSON are refused as not JSON", async () => {
    expect(await decode("{ not json")).toEqual({ ok: false, reason: "sealed input is not JSON" });
  });

  it("L9 JSON that is an array, null or a scalar is refused as not a JSON object", async () => {
    for (const text of ["[1]", "null", `"text"`, "7"]) {
      expect(await decode(text), text).toEqual({ ok: false, reason: "sealed input is not a JSON object" });
    }
  });

  it("L10 a JSON object is returned as the record", async () => {
    expect(await decode(`{"slug":"probe","n":1}`)).toEqual({ ok: true, record: { slug: "probe", n: 1 } });
  });
});

describe("run lookup over its own reads: a rejecting read is not caught", () => {
  it("L11 a rejecting scan rejects locate and resolve with the same object", async () => {
    const reads: PreparationRunLookupReads = { ...storeOf().reads, scanInventory: () => Promise.reject(BOOM) };
    await expect(locatePreparationManifestFrom(reads, "prr_one")).rejects.toBe(BOOM);
    await expect(resolvePreparationRunFrom(reads, "prr_one")).rejects.toBe(BOOM);
  });

  it("L11 a rejecting key read rejects with the same object, and no run is read", async () => {
    const store = storeOf();
    const reads: PreparationRunLookupReads = { ...store.reads, readKeyEpoch: () => Promise.reject(BOOM) };
    await expect(readPreparationRunForManifestFrom(reads, manifestOf("prr_one"))).rejects.toBe(BOOM);
    expect(store.log).toEqual([]);
  });

  it("L11 a rejecting run read rejects with the same object", async () => {
    const store = storeOf({ manifests: [manifestOf("prr_one")] });
    const reads: PreparationRunLookupReads = { ...store.reads, readRun: () => Promise.reject(BOOM) };
    await expect(resolvePreparationRunFrom(reads, "prr_one")).rejects.toBe(BOOM);
    expect(store.log).toEqual([["scan"], ["key"]]);
  });

  it("L11 a rejecting evidence read rejects with the same object, outside the JSON catch", async () => {
    const reads: PreparationRunLookupReads = { ...storeOf().reads, readEvidenceBytes: () => Promise.reject(BOOM) };
    await expect(readPreparationInitialInputFrom(reads, manifestOf("prr_one"))).rejects.toBe(BOOM);
  });
});
