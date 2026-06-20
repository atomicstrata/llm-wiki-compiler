import { describe, it, expect } from "vitest";
import { embedTextBatch, EmbeddingIntegrityError } from "../src/utils/embeddings-batch.js";
import type { LLMProvider } from "../src/utils/provider.js";

const VEC = [0.1, 0.2];
const withStatus = (s: number, m = "") => Object.assign(new Error(m), { status: s });

// Minimal provider stub: only embed + embedBatch matter here.
function makeProvider(over: Partial<LLMProvider>): LLMProvider {
  return {
    complete: async () => "", stream: async () => "", toolCall: async () => "",
    embed: async () => VEC,
    ...over,
  } as LLMProvider;
}

/** Assert a single-item batch returned one VEC and call counts match expectations. */
async function assertSingleResult(
  p: LLMProvider,
  counts: { batchCalls: number; embedCalls: number },
  expectedBatch: number,
  expectedEmbed: number,
): Promise<void> {
  const out = await embedTextBatch(p, ["a"], 2);
  expect(out).toEqual([VEC]);
  expect(counts.batchCalls).toBe(expectedBatch);
  expect(counts.embedCalls).toBe(expectedEmbed);
}

describe("embedTextBatch fallback policy", () => {
  it("sub-batches and preserves order", async () => {
    const seen: string[][] = [];
    const p = makeProvider({ embedBatch: async (t) => { seen.push(t); return t.map(() => VEC); } });
    const out = await embedTextBatch(p, ["a", "b", "c"], 2);
    expect(out).toHaveLength(3);
    expect(seen).toEqual([["a", "b"], ["c"]]); // 256-style split shown at size 2
  });

  it("falls back to sequential when embedBatch is absent", async () => {
    let calls = 0;
    const p = makeProvider({ embed: async () => { calls++; return VEC; } });
    const out = await embedTextBatch(p, ["a", "b"], 2);
    expect(out).toEqual([VEC, VEC]);
    expect(calls).toBe(2);
  });

  it("throws on integrity error, no fallback", async () => {
    const p = makeProvider({ embedBatch: async () => { throw new EmbeddingIntegrityError("cardinality"); } });
    await expect(embedTextBatch(p, ["a"], 2)).rejects.toBeInstanceOf(EmbeddingIntegrityError);
  });

  it("throws on auth error, no fallback", async () => {
    let embedCalls = 0;
    const p = makeProvider({
      embed: async () => { embedCalls++; return VEC; },
      embedBatch: async () => { throw withStatus(401); },
    });
    await expect(embedTextBatch(p, ["a"], 2)).rejects.toBeTruthy();
    expect(embedCalls).toBe(0); // never fell back
  });

  it("request-too-large -> sequential immediately, no retry", async () => {
    let batchCalls = 0, embedCalls = 0;
    const p = makeProvider({
      embed: async () => { embedCalls++; return VEC; },
      embedBatch: async () => { batchCalls++; throw withStatus(413); },
    });
    const out = await embedTextBatch(p, ["a", "b"], 2);
    expect(out).toEqual([VEC, VEC]);
    expect(batchCalls).toBe(1); // no retry
    expect(embedCalls).toBe(2);
  });

  it("transient -> one retry, then sequential", async () => {
    const counts = { batchCalls: 0, embedCalls: 0 };
    const p = makeProvider({
      embed: async () => { counts.embedCalls++; return VEC; },
      embedBatch: async () => { counts.batchCalls++; throw withStatus(429); },
    });
    await assertSingleResult(p, counts, 2, 1); // initial + one retry, then sequential
  });

  it("retries a transient sequential fallback item once", async () => {
    const counts = { batchCalls: 0, embedCalls: 0 };
    const p = makeProvider({
      embed: async () => {
        counts.embedCalls++;
        if (counts.embedCalls === 1) throw withStatus(429);
        return VEC;
      },
      embedBatch: async () => { counts.batchCalls++; throw withStatus(429); },
    });

    const out = await embedTextBatch(p, ["a"], 2);

    expect(out).toEqual([VEC]);
    expect(counts).toEqual({ batchCalls: 2, embedCalls: 2 });
  });

  it("transient that succeeds on retry does not fall back", async () => {
    const counts = { batchCalls: 0, embedCalls: 0 };
    const p = makeProvider({
      embed: async () => { counts.embedCalls++; return VEC; },
      embedBatch: async (t) => { counts.batchCalls++; if (counts.batchCalls === 1) throw withStatus(503); return t.map(() => VEC); },
    });
    await assertSingleResult(p, counts, 2, 0); // retry succeeds, no sequential fallback
  });

  it("transient then an UNKNOWN error on retry throws (no fallback)", async () => {
    let embedCalls = 0, batchCalls = 0;
    const p = makeProvider({
      embed: async () => { embedCalls++; return VEC; },
      embedBatch: async () => { batchCalls++; throw batchCalls === 1 ? withStatus(429) : withStatus(400, "bad input"); },
    });
    await expect(embedTextBatch(p, ["a"], 2)).rejects.toBeTruthy();
    expect(batchCalls).toBe(2); // initial + retry
    expect(embedCalls).toBe(0); // unknown retry error -> NO sequential fallback
  });

  it("annotates the thrown error with the failing global index", async () => {
    const p = makeProvider({
      embedBatch: async (t: string[]) => { if (t.includes("c")) throw new EmbeddingIntegrityError("cardinality"); return t.map(() => VEC); },
    });
    // size 2 -> sub-batches ["a","b"], ["c","d"]; the second fails, startIndex 2.
    await expect(embedTextBatch(p, ["a", "b", "c", "d"], 2)).rejects.toMatchObject({ failedIndex: 2 });
  });
});
