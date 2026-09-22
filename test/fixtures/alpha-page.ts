/** Shared retained-page fixtures for query and search fallback regressions. */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, vi } from "vitest";
import * as provider from "../../src/utils/provider.js";
import { makeTempRoot } from "./temp-root.js";
import { writePage } from "./write-page.js";
import { pageEntryOf, writePageStore } from "./typed-grounding.js";

/** Register cleanup once and return a root factory with an optional live page store. */
export function useAlphaPageFixture(prefix: string, pageStore = false): () => Promise<string> {
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });
  return async () => {
    const root = await makeTempRoot(prefix);
    roots.push(root);
    await writeFile(path.join(root, "wiki", "index.md"), "# Index\n");
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha", summary: "a" }, "ALPHA_BODY fact.");
    if (pageStore) {
      await mkdir(path.join(root, ".llmwiki"), { recursive: true });
      await writePageStore(root, [pageEntryOf("concepts/alpha", "Alpha", "a", [1, 0])]);
    }
    return root;
  };
}

/** Fail both embedding paths; return the spy so tests prove the path was reached. */
export function mockEmbeddingFailure() {
  const embed = vi.fn(async () => { throw new Error("no embedding credentials"); });
  vi.spyOn(provider, "getProvider").mockReturnValue(
    { embed, embedBatch: embed } as unknown as ReturnType<typeof provider.getProvider>,
  );
  return embed;
}
