/**
 * @file test/atomic-write-durable-ancestors.test.ts
 * @description A strictly durable write syncs its parent every time, and each ancestor
 * up to the confining root until that ancestor is known to hold the directory
 * below it durably. That knowledge is keyed by the child directory's identity
 * AND name: renaming a directory within its parent changes the parent's entry,
 * so the next durable write below it must sync the parent again.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWrite } from "../src/utils/atomic-write.js";

let root: string;

/** Durably write `file` under `root`, returning every directory the write synced. */
async function syncedBy(file: string): Promise<string[]> {
  const synced: string[] = [];
  await atomicWrite(file, "x", {
    confineRoot: root, durable: true, strictDurability: true,
    beforeDirectorySyncForTest: async (dir) => { synced.push(path.resolve(dir)); },
  });
  return synced;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "durable-ancestors-")));
  mkdirSync(path.join(root, "parent", "staging"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("durable ancestor syncs", () => {
  it("syncs an ancestor once while it keeps holding the same directory", async () => {
    const parent = path.join(root, "parent");
    expect(await syncedBy(path.join(parent, "staging", "a.md"))).toContain(parent);
    expect(await syncedBy(path.join(parent, "staging", "b.md"))).not.toContain(parent);
  });

  it("syncs the parent again after the directory below it is renamed", async () => {
    const parent = path.join(root, "parent");
    await syncedBy(path.join(parent, "staging", "a.md"));
    renameSync(path.join(parent, "staging"), path.join(parent, "published"));
    expect(await syncedBy(path.join(parent, "published", "b.md"))).toContain(parent);
  });
});
