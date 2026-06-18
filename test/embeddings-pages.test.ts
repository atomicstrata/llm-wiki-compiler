/**
 * Tests for page-level batched embedding pass.
 */

import { describe, it, expect, vi } from "vitest";
import { embedPages } from "../src/utils/embeddings-pages.js";
import * as providerMod from "../src/utils/provider.js";
import type { PageRecord } from "../src/utils/embeddings-pages.js";

describe("embedPages batching", () => {
  it("embeds changed pages via a single embedBatch call", async () => {
    const calls: string[][] = [];
    vi.spyOn(providerMod, "getProvider").mockReturnValue({
      embed: async () => [1, 1],
      embedBatch: async (t: string[]) => { calls.push(t); return t.map(() => [1, 1]); },
    } as any);
    const records: PageRecord[] = [
      { slug: "a", title: "A", summary: "sa", body: "" },
      { slug: "b", title: "B", summary: "sb", body: "" },
    ];
    const out = await embedPages(records, new Set(["a", "b"]), 256);
    expect(out.map((e) => e.slug)).toEqual(["a", "b"]);
    expect(calls).toHaveLength(1); // one batch, not two singles
    expect(calls[0]).toEqual(["A\n\nsa", "B\n\nsb"]);
  });
});
