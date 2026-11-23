/**
 * @file test/vectors/helpers.ts
 * @description An offline, deterministic embedding provider for vector tests:
 * each text maps to an 8-dimensional vector of multiples of 1/128 derived
 * from its SHA-256, so every value is exact in float32 and scores computed on
 * a JSON store and on float32 pieces agree exactly. Also provides shared
 * private fixture lifecycle and verification for offline vector tests.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { restoreEnv, restoreGlobals, stubEnv, stubGlobal } from "../stubs.js";
import { EMBEDDINGS_FILE } from "../../src/utils/constants.js";
import * as provider from "../../src/utils/embedding-provider.js";
import { verifyVectors } from "../../src/vectors/verify.js";

/** Texts embedded so far by the fake provider. */
export const embedded = { texts: 0 };

/** The deterministic vector of `text`. */
export function vectorOf(text: string): number[] {
  const digest = createHash("sha256").update(text).digest();
  return Array.from({ length: 8 }, (_, at) => (digest[at]! - 128) / 128);
}

/** The provider environment of the offline vector tests (the key is a placeholder no request ever carries). */
const OFFLINE_ENV: Readonly<Record<string, string>> = {
  LLMWIKI_PROVIDER: "openai", LLMWIKI_EMBEDDING_PROVIDER: "openai", LLMWIKI_EMBEDDING_MODEL: "offline-embed",
  OPENAI_API_KEY: "test-key", LLMWIKI_BINARY_EMBEDDINGS: "",
};

/** Install the offline provider and its environment. */
export function useOfflineEmbeddings(): void {
  for (const [name, value] of Object.entries(OFFLINE_ENV)) stubEnv(name, value);
  stubGlobal("fetch", () => { throw new Error("network forbidden in vector tests"); });
  embedded.texts = 0;
  vi.spyOn(provider, "getEmbeddingProvider").mockReturnValue({
    embed: async (text: string) => { embedded.texts += 1; return vectorOf(text); },
    embedBatch: async (texts: string[]) => { embedded.texts += texts.length; return texts.map(vectorOf); },
  } as unknown as ReturnType<typeof provider.getEmbeddingProvider>);
}

/** Give each case a fresh private root and restore offline seams on teardown. */
export function useOfflineVectorFixture(prefix: string): { readonly root: string } {
  let root: string | undefined;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), prefix));
    useOfflineEmbeddings();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    restoreEnv();
    restoreGlobals();
    if (root !== undefined) {
      const owned = root;
      root = undefined;
      await rm(owned, { recursive: true, force: true });
    }
  });
  return {
    get root() {
      if (root === undefined) throw new Error("offline vector fixture is not active");
      return root;
    },
  };
}

/** Assert indexed verification and byte-for-byte preservation of the incumbent backup. */
export async function expectVerifiedVectorBackup(root: string, backup: Buffer, records?: number): Promise<void> {
  expect(await verifyVectors(root)).toMatchObject({ ok: true, problemCount: 0, ...(records === undefined ? {} : { records }) });
  expect<Buffer>(await readFile(path.join(root, EMBEDDINGS_FILE))).toEqual(backup);
}

/** Write page `slug` under `dir` with a body that splits into `paragraphs` chunks. */
export async function writePage(root: string, dir: "concepts" | "queries", slug: string, body: string): Promise<void> {
  await mkdir(path.join(root, "wiki", dir), { recursive: true });
  await writeFile(path.join(root, "wiki", dir, `${slug}.md`), `---\ntitle: ${slug}\nsummary: About ${slug}\n---\n\n${body}\n`);
}
