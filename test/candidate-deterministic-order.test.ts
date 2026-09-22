/**
 * @file test/candidate-deterministic-order.test.ts
 * @description Equal-time candidate enumeration uses exact filename UTF-8 byte
 * order rather than locale collation or filesystem enumeration order.
 */

import { describe, expect, it } from "vitest";
import {
  compareCandidateFileIdsUtf8,
  listCandidateFileEntries,
} from "../src/compiler/candidate-read.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { plantConnectorCandidate } from "./connectors/final6-fixtures.js";

const root = useTempRoot();

/** Reference byte comparator independent of locale and code-point collation. */
function referenceUtf8Order(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

describe("candidate deterministic filename ordering", () => {
  it("compares exact file ids in UTF-8 byte order", () => {
    const ids = ["\u{10000}", "\ue000", "éclair", "alpha"];

    expect(compareCandidateFileIdsUtf8).toBeTypeOf("function");
    expect([...ids].sort(compareCandidateFileIdsUtf8))
      .toEqual([...ids].sort(referenceUtf8Order));
  });

  it("uses the byte tie-break when generated timestamps are equal", async () => {
    const ids = ["zeta", "éclair", "alpha"];
    for (const id of ids) await plantConnectorCandidate(root.dir, id);

    const entries = await listCandidateFileEntries(root.dir);

    expect(entries.map(({ fileId }) => fileId))
      .toEqual([...ids].sort(referenceUtf8Order));
  });
});
