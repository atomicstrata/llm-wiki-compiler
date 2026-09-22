/**
 * @file test/atomic-write-durable-hardlink.test.ts
 * @description Regression proofs that strict create-only publication rejects
 * external aliases at ready-adoption and final-settlement boundaries while
 * leaving the internal two-link commit protocol covered by its existing tests.
 */

import { link, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWriteNoReplaceDurable } from "../src/utils/atomic-write.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

describe("durable no-replace hardlink boundaries", () => {
  it("refuses a ready-only inode with an external alias", async () => {
    const parent = path.join(root.dir, "ready-external-alias");
    const target = path.join(parent, "record");
    const ready = `${target}.tmp`;
    const external = path.join(root.dir, "external-ready-alias");
    await mkdir(parent);
    await writeFile(ready, "body");
    await link(ready, external);

    await expect(atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: root.dir,
    })).rejects.toThrow(/link|alias|cleanup|metadata/i);
    expect(await readFile(external, "utf8")).toBe("body");
  });

  it("refuses a newly committed destination with an external alias", async () => {
    const parent = path.join(root.dir, "settled-external-alias");
    const target = path.join(parent, "record");
    const external = path.join(root.dir, "external-destination-alias");
    await mkdir(parent);

    await expect(atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: root.dir,
      afterNoReplaceCommitForTest: async () => { await link(target, external); },
    })).rejects.toThrow(/link|alias|destination/i);
    expect(await readFile(external, "utf8")).toBe("body");
  });
});
