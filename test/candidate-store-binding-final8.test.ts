/**
 * @file test/candidate-store-binding-final8.test.ts
 * @description Decision 17 regressions keep strict mutation enumeration bound
 * to one lexical candidate-store identity across open, stream, and return.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureCandidateStoreBinding,
  CandidateCustodyUnavailableError,
} from "../src/compiler/candidate-custody.js";
import { listCandidateMutationFileIdsForBinding } from "../src/compiler/candidate-read.js";
import {
  selectCandidateEntriesForMutationWithTotal,
  type CandidateMutationSelectionHooks,
} from "../src/compiler/candidate-selection.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { plantConnectorCandidate } from "./connectors/final6-fixtures.js";

const root = useTempRoot();

/** Replace the lexical store with a different empty or nonempty directory. */
async function replaceStore(nonempty: boolean): Promise<void> {
  const dir = path.join(root.dir, ".llmwiki", "candidates");
  const moved = `${dir}-moved-${Math.random().toString(16).slice(2)}`;
  await rename(dir, moved);
  await mkdir(dir, { recursive: true });
  if (nonempty) await writeFile(path.join(dir, "alternate.json"), "{}");
}

/** Build a one-shot replacement hook for the named scan phase. */
function hooks(
  phase: "custody" | "open" | "enumerated" | "return",
  nonempty: boolean,
): CandidateMutationSelectionHooks {
  const replace = () => replaceStore(nonempty);
  if (phase === "custody") return { afterInitialCustodyForTest: replace };
  if (phase === "open") return { afterOpenForTest: replace };
  if (phase === "enumerated") return { afterEnumerationForTest: replace };
  return { beforeReturnForTest: replace };
}

describe("Final8 strict candidate-store binding", () => {
  it("deep-freezes the store authority snapshot", async () => {
    await mkdir(path.join(root.dir, ".llmwiki", "candidates"), { recursive: true });

    const binding = await captureCandidateStoreBinding(root.dir);

    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding?.identity)).toBe(true);
  });

  it("rejects a forged direct binding before opening its real directory", async () => {
    const candidates = path.join(root.dir, ".llmwiki", "candidates");
    const unrelated = path.join(root.dir, "unrelated");
    await mkdir(candidates, { recursive: true });
    await mkdir(unrelated);
    const binding = await captureCandidateStoreBinding(root.dir);
    let opened = false;

    const listing = listCandidateMutationFileIdsForBinding(
      root.dir,
      Object.freeze({ ...binding!, realDir: unrelated }),
      { afterOpenForTest: async () => { opened = true; } },
    );

    await expect(listing).rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
    expect(opened).toBe(false);
  });

  it.each([
    ["custody", false], ["custody", true],
    ["open", false], ["open", true],
    ["enumerated", false], ["enumerated", true],
    ["return", false], ["return", true],
  ] as const)("rejects %s-phase replacement with nonempty=%s", async (phase, nonempty) => {
    if (phase === "custody" || phase === "open") {
      await mkdir(path.join(root.dir, ".llmwiki", "candidates"), { recursive: true });
    } else {
      await plantConnectorCandidate(root.dir, "original");
    }

    const listing = selectCandidateEntriesForMutationWithTotal(
      root.dir, () => true, undefined, hooks(phase, nonempty),
    );

    await expect(listing).rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
  });
});
