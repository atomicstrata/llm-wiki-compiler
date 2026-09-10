/**
 * @file test/embeddings-disabled.test.ts
 * @description Environment opt-out coverage for all shared embedding refresh callers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "fs";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { mkdtemp } from "fs/promises";
import { refreshEmbeddingsDrainingPending } from "../src/utils/embeddings-refresh.js";
import { updateEmbeddingsLockedCore } from "../src/utils/embeddings.js";
import { EMBEDDINGS_FILE, ENV_EMBEDDINGS, PENDING_EMBEDDINGS_FILE } from "../src/utils/constants.js";
import * as embeddings from "../src/utils/embeddings.js";
import * as output from "../src/utils/output.js";
import * as provider from "../src/utils/provider.js";
import type { PageId } from "../src/utils/page-id.js";

const PAGE_ID = "concepts/alpha" as PageId;
const PENDING_CONTENT = '[{"pageId":"concepts/prior","attempts":2}]\n';
let root = "";
let originalEmbeddingsSetting: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "embeddings-disabled-"));
  originalEmbeddingsSetting = process.env[ENV_EMBEDDINGS];
  delete process.env[ENV_EMBEDDINGS];
  vi.spyOn(output, "verbose").mockImplementation(() => {});
});

afterEach(async () => {
  if (originalEmbeddingsSetting === undefined) delete process.env[ENV_EMBEDDINGS];
  else process.env[ENV_EMBEDDINGS] = originalEmbeddingsSetting;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** Return the path to the durable pending-embeddings marker. */
function pendingPath(): string {
  return path.join(root, PENDING_EMBEDDINGS_FILE);
}

/** Exercise an enabled refresh and report its provider call. */
async function expectRefreshRuns(value: string | undefined): Promise<void> {
  if (value === undefined) delete process.env[ENV_EMBEDDINGS];
  else process.env[ENV_EMBEDDINGS] = value;
  const provider = vi.spyOn(embeddings, "updateEmbeddingsLockedCore").mockResolvedValue({
    embedded: [PAGE_ID],
    eligible: [PAGE_ID],
  });

  await refreshEmbeddingsDrainingPending(root, [PAGE_ID]);

  expect(provider).toHaveBeenCalledOnce();
}

describe("LLMWIKI_EMBEDDINGS", () => {
  it.each(["0", "false", "no", "off", " OfF "])(
    "leaves pending state untouched and calls no provider when set to %j",
    async (value) => {
      await mkdir(path.dirname(pendingPath()), { recursive: true });
      await writeFile(pendingPath(), PENDING_CONTENT, "utf-8");
      process.env[ENV_EMBEDDINGS] = value;
      const provider = vi.spyOn(embeddings, "updateEmbeddingsLockedCore");

      await refreshEmbeddingsDrainingPending(root, [PAGE_ID]);

      expect(provider).not.toHaveBeenCalled();
      expect(await readFile(pendingPath(), "utf-8")).toBe(PENDING_CONTENT);
      expect(output.verbose).toHaveBeenCalledWith(expect.stringContaining("LLMWIKI_EMBEDDINGS"));
    },
  );

  it("skips direct core refreshes used by query --save when set to off", async () => {
    const storePath = path.join(root, EMBEDDINGS_FILE);
    const storeContent = "existing embedding store must remain untouched\n";
    const conceptPath = path.join(root, "wiki/concepts/alpha.md");
    await mkdir(path.dirname(storePath), { recursive: true });
    await mkdir(path.dirname(conceptPath), { recursive: true });
    await writeFile(storePath, storeContent, "utf-8");
    await writeFile(conceptPath, "---\ntitle: Alpha\nsummary: Alpha summary\n---\n\nAlpha body.\n", "utf-8");
    process.env[ENV_EMBEDDINGS] = "off";
    const getProvider = vi.spyOn(provider, "getProvider").mockReturnValue({
      embed: async () => [0.5, 0.5],
      embedBatch: async (texts: string[]) => texts.map(() => [0.5, 0.5]),
    } as unknown as ReturnType<typeof provider.getProvider>);

    const result = await updateEmbeddingsLockedCore(root, [PAGE_ID]);

    expect(result).toEqual({ embedded: [], eligible: [] });
    expect(getProvider).not.toHaveBeenCalled();
    expect(await readFile(storePath, "utf-8")).toBe(storeContent);
  });

  it("preserves embedding refresh when unset", async () => {
    await expectRefreshRuns(undefined);
  });

  it("runs store reconciliation without creating an empty pending marker", async () => {
    const provider = vi.spyOn(embeddings, "updateEmbeddingsLockedCore").mockResolvedValue({
      embedded: [],
      eligible: [],
    });

    await refreshEmbeddingsDrainingPending(root, []);

    expect(provider).toHaveBeenCalledWith(root, []);
    expect(existsSync(pendingPath())).toBe(false);
  });

  it("preserves embedding refresh for values other than off", async () => {
    await expectRefreshRuns("on");
  });
});
