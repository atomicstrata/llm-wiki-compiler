/**
 * Binary callers retain exact bytes and the existing atomic replacement boundary.
 * Fault injection targets rename only; real temp-file creation and writes run.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import path from "node:path";
import { atomicWrite } from "../src/utils/atomic-write.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const ctx = useConfinementRoots("atomic-bytes");
afterEach(() => vi.restoreAllMocks());

describe("atomic byte writes", () => {
  it("persists non-text bytes without UTF-8 conversion", async () => {
    const target = path.join(ctx.root, "index.bin");
    const bytes = new Uint8Array([0, 255, 128, 13, 10, 0]);
    await atomicWrite(target, bytes, { confineRoot: ctx.root });
    expect(await fs.readFile(target)).toEqual(Buffer.from([0, 255, 128, 13, 10, 0]));
  });

  it("keeps the prior binary and cleans the temp if rename fails", async () => {
    const target = path.join(ctx.root, "index.bin");
    await atomicWrite(target, Buffer.from([0, 255]), { confineRoot: ctx.root });
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("rename failed"));
    await expect(atomicWrite(target, Buffer.from([128, 10]), { confineRoot: ctx.root })).rejects.toThrow("rename failed");
    expect(await fs.readFile(target)).toEqual(Buffer.from([0, 255]));
    expect(await fs.readdir(ctx.root)).toEqual(["index.bin"]);
  });
});
