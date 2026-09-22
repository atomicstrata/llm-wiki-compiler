/**
 * @file test/operations-packs/composition-lock.test.ts
 * @description Independent composition-lock recomputation (design section 11.2).
 * The loader recomputes the graph digest and resolved-export table from the pack
 * and REFUSES any supplied lock whose bytes disagree — a tampered graph digest,
 * edited resolved exports, or a wrong root pack digest — because a lock is
 * evidence, not permission. A structurally malformed lock fails closed distinctly.
 */

import { describe, expect, it } from "vitest";
import {
  parseCompositionLock, recomputeCompositionLock, verifyCompositionLock,
} from "../../src/operations-packs/composition-lock.js";
import { parseOperationsPack } from "../../src/operations-packs/parse.js";
import { CompositionLockError, PackParseError } from "../../src/operations-packs/problems.js";
import { buildPack, dg, serialize } from "./pack-fixture.js";

const pack = parseOperationsPack(serialize(buildPack()));
const lock = recomputeCompositionLock(pack);
const lockText = serialize(lock);

describe("composition lock recomputation", () => {
  it("recomputes a schema-1 lock with a graph digest and exports", () => {
    expect(lock.schemaVersion).toBe(1);
    expect(lock.graphDigest.startsWith("sha256:")).toBe(true);
    expect(lock.resolvedExports.length).toBeGreaterThan(0);
  });

  it("accepts a supplied lock that agrees with the recomputed graph", () => {
    expect(verifyCompositionLock(pack, lockText).graphDigest).toBe(lock.graphDigest);
  });

  it("refuses a supplied lock whose graph digest disagrees", () => {
    const tampered = { ...lock, graphDigest: dg("forged") };
    expect(() => verifyCompositionLock(pack, serialize(tampered))).toThrow(CompositionLockError);
  });

  it("refuses a supplied lock whose resolved exports were edited", () => {
    const tampered = structuredClone(lock);
    tampered.resolvedExports[0]!.objectDigest = dg("swap");
    expect(() => verifyCompositionLock(pack, serialize(tampered))).toThrow(CompositionLockError);
  });

  it("refuses a supplied lock whose root pack digest disagrees", () => {
    const tampered = { ...lock, rootPackDigest: dg("wrong-root") };
    expect(() => verifyCompositionLock(pack, serialize(tampered))).toThrow(CompositionLockError);
  });

  it("rejects a lock with a wrong schema version", () => {
    const obj = JSON.parse(lockText);
    obj.schemaVersion = 2;
    expect(() => parseCompositionLock(JSON.stringify(obj))).toThrow(PackParseError);
  });

  it("rejects a lock with an unknown field", () => {
    const obj = JSON.parse(lockText);
    obj.extra = 1;
    expect(() => parseCompositionLock(JSON.stringify(obj))).toThrow(PackParseError);
  });
});
