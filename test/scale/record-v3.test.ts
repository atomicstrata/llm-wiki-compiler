/**
 * @file test/scale/record-v3.test.ts
 * @description The version 3 scale record: version 2 plus a closed,
 * non-empty capability list. It parses and serializes round trip; unknown or
 * duplicated capabilities, a capability on a project that is not (and is not
 * becoming) indexed, and capabilities on a version 2 record are refused; the
 * next record PRESERVES held capabilities (a lowered estimate keeps them) and
 * adds a wanted one as `preparing` in the record that plans the preparation.
 */

import { describe, expect, it } from "bun:test";
import type { ScaleRecordV2 } from "../../src/scale/contracts-v2.js";
import { nextRecord } from "../../src/scale/next-record.js";
import { planScaleV2 } from "../../src/scale/plan-v2.js";
import { parseAnyScaleRecord, serializeAnyScaleRecord } from "../../src/scale/record-v2-schema.js";

/** An active indexed version 3 record holding the typed catalog capability. */
function indexedV3(status: "preparing" | "ready" = "ready"): ScaleRecordV2 {
  const planned = nextRecord(null, planScaleV2({ documents: 8_000 }), [], ["typed-entity-catalog-1"]) as ScaleRecordV2;
  return { ...planned, active: { architecture: "local-indexed", sinceRevision: planned.revision }, pending: null, capabilities: [{ name: "typed-entity-catalog-1", status }] };
}

describe("version 3 records", () => {
  it("are planned v3 with the capability preparing, and round trip", () => {
    const planned = nextRecord(null, planScaleV2({ documents: 8_000 }), [], ["typed-entity-catalog-1"]) as ScaleRecordV2;
    expect([planned.version, planned.capabilities]).toEqual([3, [{ name: "typed-entity-catalog-1", status: "preparing" }]]);
    expect(parseAnyScaleRecord(serializeAnyScaleRecord(indexedV3()))).toEqual(indexedV3());
  });

  it("refuse unknown, duplicated or misplaced capabilities", () => {
    const text = (record: unknown) => JSON.stringify(record);
    const base = indexedV3();
    expect(() => parseAnyScaleRecord(text({ ...base, capabilities: [{ name: "future-1", status: "ready" }] }))).toThrow();
    expect(() => parseAnyScaleRecord(text({ ...base, capabilities: [base.capabilities![0], base.capabilities![0]] }))).toThrow(/listed twice/);
    expect(() => parseAnyScaleRecord(text({ ...base, capabilities: [] }))).toThrow();
    expect(() => parseAnyScaleRecord(text({ ...base, version: 2 }))).toThrow();
    const standard = nextRecord(null, planScaleV2({ documents: 2_000 })) as ScaleRecordV2;
    expect(() => parseAnyScaleRecord(text({ ...standard, version: 3, policy: "local-v2", capabilities: base.capabilities }))).toThrow();
  });

  it("keep held capabilities through a lowered estimate", () => {
    const lowered = nextRecord(indexedV3(), planScaleV2({ documents: 100 })) as ScaleRecordV2;
    expect([lowered.version, lowered.active.architecture, lowered.capabilities]).toEqual([3, "local-indexed", [{ name: "typed-entity-catalog-1", status: "ready" }]]);
  });

  it("drop a preparing capability only when the indexed preparation is planned away", () => {
    const preparing = nextRecord(null, planScaleV2({ documents: 8_000 }), [], ["typed-entity-catalog-1"]);
    const replanned = nextRecord(preparing, planScaleV2({ documents: 100 }));
    expect(replanned.version).toBe(1);
  });
});
