/**
 * @file test/storage/source-identity-names-binding.test.ts
 * @description Which source names an explicit ingest treats as existing
 * identities, as ONE body over two supplied reads, `listIdentityNamesFrom` over
 * `SourceIdentityReads`, with no project. This file uses the body, which exists
 * only after the scan's selection policy was given its reads, so it has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. Memory reads answer a selection that excludes an inbox and
 * record the selection they are asked to list, so the policy is pinned: the
 * selection is loaded before anything is listed, its compile exclusions are
 * dropped while its recursion is kept, the loaded selection itself is left
 * untouched, and the listing's answer is returned as is. The composition is
 * shown reaching the selection and scan bodies, and `saveSource` the incumbent
 * selection and scan at the CANONICAL root.
 *
 * NOT SHOWN HERE: selection parsing, the scan itself and the collision naming;
 * the source-writer, selection and scan suites show those.
 */

import { realpath } from "node:fs/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as scan from "../../src/sources/scan.js";
import * as selectionModule from "../../src/sources/selection.js";
import { listIdentityNamesFrom, saveSource, sourceIdentityReadsOver } from "../../src/utils/source-writer.js";
import { tempRootTracker } from "../temp-roots.js";

const tracker = tempRootTracker();
afterAll(() => tracker.cleanup());
afterEach(() => { vi.restoreAllMocks(); });

const SELECTION = { recursive: true, exclude: ["inbox"] };

describe("the identity-name scan over its reads", () => {
  it("I1 loads the selection first, then lists it with compile exclusions dropped and recursion kept", async () => {
    const log: string[] = [];
    const loaded = { ...SELECTION, exclude: [...SELECTION.exclude] };
    const names = await listIdentityNamesFrom({
      loadSelection: async () => { log.push("load"); return loaded; },
      listSelected: async (selection) => { log.push(`list ${JSON.stringify(selection)}`); return ["a.md", "inbox/b.md"]; },
    });
    expect([names, log, loaded]).toEqual([["a.md", "inbox/b.md"], ["load", 'list {"recursive":true,"exclude":[]}'], SELECTION]);
  });

  it("I2 the composition reaches the selection and scan bodies over the one read seam", async () => {
    const load = vi.spyOn(selectionModule, "loadSourceSelectionFrom").mockResolvedValue(SELECTION);
    const list = vi.spyOn(scan, "listSelectedSourceFilesFrom").mockResolvedValue(["a.md"]);
    const reads = { tag: "reads" } as never;
    expect(await listIdentityNamesFrom(sourceIdentityReadsOver(reads))).toEqual(["a.md"]);
    expect([load.mock.calls, list.mock.calls]).toEqual([[[reads]], [[reads, { recursive: true, exclude: [] }]]]);
  });
});

describe("the root form", () => {
  it("R1 saveSource asks the incumbent selection and scan at the canonical root, exclusions dropped", async () => {
    const root = await tracker.create("source-identity-names-");
    const load = vi.spyOn(selectionModule, "loadSourceSelection").mockResolvedValue(SELECTION);
    const list = vi.spyOn(scan, "listSelectedSourceFiles").mockResolvedValue([]);
    await saveSource(root, "A title", "body\n", "https://example.test/a");
    const canonical = await realpath(root);
    expect([load.mock.calls, list.mock.calls]).toEqual([[[canonical]], [[canonical, { recursive: true, exclude: [] }]]]);
  });
});
