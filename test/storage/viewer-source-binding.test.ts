/**
 * @file test/storage/viewer-source-binding.test.ts
 * @description The read binding behind the viewer's raw-source preview. This
 * file uses `readViewerSourceFrom` and `diskLocalCappedReads`, which exist only
 * after the preview was routed through a binding, so it has NO before-edit run
 * and is not part of the before-and-after comparison in
 * `viewer-source-preview.test.ts`.
 *
 * B1 passes an in-memory binding and shows the preview is served from it: the
 * three outcomes map to the three health values, the binding is asked for the
 * project-relative path and the cap, and the disk primitive is never called.
 * B2 shows the same spy DOES see the primitive when the disk binding is used,
 * once per read, so B1's zero means something.
 *
 * An in-memory object here is a test double. It is not a hosted store, not an
 * access-control layer and not `ProjectStore`; the id rule, the allowlist and
 * the loopback gate stay in the caller either way.
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { diskLocalCappedReads } from "../../src/storage/disk-local-reads.js";
import type { CappedTextRead, LegacyLocalCappedReads } from "../../src/storage/legacy-local-reads.js";
import * as confinedRead from "../../src/utils/confined-read.js";
import { readViewerSourceFrom } from "../../src/viewer/source-access.js";
import { useTempRoot } from "../fixtures/temp-root.js";
const ONE_MIB = 1024 * 1024;
const ID = "notes/a.md";
const RELATIVE = path.join("sources", ID);
useTempRoot();

afterEach(() => { vi.restoreAllMocks(); });

describe("the viewer source preview over a binding", () => {
  it("B1 serves all three outcomes from an in-memory binding without touching the disk primitive", async () => {
    const primitive = vi.spyOn(confinedRead, "readConfinedLeaf");
    const asked: Array<[string, number]> = [];
    const outcomes: CappedTextRead[] = [{ kind: "ok", body: "from memory\n" }, { kind: "absent" }, { kind: "unavailable" }];
    const memory: LegacyLocalCappedReads = {
      readCappedText: async (relPath, maxBytes) => {
        asked.push([relPath, maxBytes]);
        return outcomes[asked.length - 1]!;
      },
    };
    const served: Array<Record<string, unknown>> = [];
    for (let read = 0; read < outcomes.length; read += 1) served.push(await readViewerSourceFrom(memory, [ID], ID, true));
    expect(served.map((result) => result.health)).toEqual(["ok", "missing", "unavailable"]);
    expect(served[0]!.body).toBe("from memory\n");
    expect(served.slice(1).some((result) => "body" in result)).toBe(false);
    expect(asked).toEqual([[RELATIVE, ONE_MIB], [RELATIVE, ONE_MIB], [RELATIVE, ONE_MIB]]);
    expect(primitive).toHaveBeenCalledTimes(0);
  });

  it("B2 reaches the disk primitive exactly once per read through the disk binding", async () => {
    const root = path.join(process.cwd(), "project");
    await fs.mkdir(path.join(root, "sources", "notes"), { recursive: true });
    await fs.writeFile(path.join(root, RELATIVE), "on disk\n", "utf-8");
    const primitive = vi.spyOn(confinedRead, "readConfinedLeaf");
    const reads = diskLocalCappedReads(root);
    expect(primitive).toHaveBeenCalledTimes(0);
    expect(await reads.readCappedText(RELATIVE, 64)).toEqual({ kind: "ok", body: "on disk\n" });
    expect(primitive).toHaveBeenCalledTimes(1);
    primitive.mockClear();
    expect(await reads.readCappedText(path.join("sources", "notes", "none.md"), 64)).toEqual({ kind: "absent" });
    expect(primitive).toHaveBeenCalledTimes(1);
  });
});
