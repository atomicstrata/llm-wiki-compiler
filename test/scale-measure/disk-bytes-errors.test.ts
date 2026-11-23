/**
 * @file test/scale-measure/disk-bytes-errors.test.ts
 * @description Disk measurements count absent areas as zero but refuse paths
 * that exist and cannot be enumerated, so a broken measurement is visible.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "bun:test";
import { diskBytes } from "./environment.js";

it("counts a genuinely absent corpus area as zero", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-disk-bytes-"));
  try {
    expect((await diskBytes(root)).sources).toEqual({ files: 0, bytes: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses a corpus area that exists but is not a directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-disk-bytes-"));
  try {
    await writeFile(path.join(root, "sources"), "unreadable as a directory");
    await expect(diskBytes(root)).rejects.toMatchObject({ code: "ENOTDIR" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses an indexed store parent that exists but is not a directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-disk-bytes-"));
  try {
    await mkdir(path.join(root, ".llmwiki"));
    await writeFile(path.join(root, ".llmwiki", "indexed"), "not a store directory");
    await expect(diskBytes(root)).rejects.toMatchObject({ code: "ENOTDIR" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses an incumbent file whose parent cannot be traversed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-disk-bytes-"));
  try {
    await mkdir(path.join(root, "wiki"));
    await writeFile(path.join(root, "wiki", "graph"), "not a directory");
    await expect(diskBytes(root)).rejects.toMatchObject({ code: "ENOTDIR" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
