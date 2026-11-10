/**
 * @file test/storage/viewer-source-preview.test.ts
 * @description The viewer's raw-source preview (`/api/source/*` and the source
 * review excerpts) through its REAL `readViewerSource`, on real files in a temp
 * directory. The file states what routing that preview's one disk read through
 * a storage binding must not change, so it is run byte for byte against the
 * source both before and after that change.
 *
 * Five cases assert outcomes the existing viewer tests do not state: a nested
 * id, a `sources` directory that leads out of the project, the exact byte cap,
 * strict UTF-8, and the difference between a project that cannot be resolved
 * (`unavailable`) and a file that is simply not there (`missing`). A1 is the
 * only argument case: it wraps ONE boundary, the confined-read primitive,
 * passes every call through, and asserts the whole recorded list.
 *
 * Nothing is injected. Every project used here is a directory this fixture
 * creates under its own temp root.
 */

import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "bun:test";

/** Every call of the confined-read primitive, as its raw argument list. */
const primitive = (() => ({ calls: [] as unknown[][] }))();

// Snapshot real modules before mock.module replaces them for this file.
const realFsPromises = { ...(await import("node:fs/promises")) };

const realUtilsConfinedRead = { ...(await import("../../src/utils/confined-read.js")) };

vi.mock("../../src/utils/confined-read.js", async () => {
  const actual = (realUtilsConfinedRead as typeof import("../../src/utils/confined-read.js"));
  const readConfinedLeaf = (...args: unknown[]): unknown => {
    primitive.calls.push(args);
    return (actual.readConfinedLeaf as (...rest: unknown[]) => unknown)(...args);
  };
  return { ...actual, readConfinedLeaf };
});

import { readViewerSource } from "../../src/viewer/source-access.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const fs = realFsPromises as typeof import("node:fs/promises");
const ONE_MIB = 1024 * 1024;
const NESTED_ID = "papers/a.md";
const NESTED_TEXT = "---\ntitle: Zażółć\n---\nRaw body — 規則は必ず守る\n";
useTempRoot();

/** The project these cases read: a directory inside the fixture's own temp root. */
const project = (): string => path.join(process.cwd(), "project");
const inProject = (...parts: string[]): string => path.join(project(), ...parts);

/** Write bytes at `sources/<id>` in the project, creating its directory. */
async function putSource(id: string, content: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(inProject("sources", id)), { recursive: true });
  await fs.writeFile(inProject("sources", id), content);
}

/** Read one allowlisted id from the project as a loopback client. */
const preview = (id: string, root = project()): Promise<Record<string, unknown>> => readViewerSource(root, [id], id, true);

beforeEach(() => { primitive.calls.length = 0; });

describe("the viewer source preview on real files", () => {
  it("P1 reads a nested id with its exact text, non-ASCII included", async () => {
    await putSource(NESTED_ID, NESTED_TEXT);
    const result = await preview(NESTED_ID);
    expect(result.health).toBe("ok");
    expect(result.body).toBe(NESTED_TEXT);
    expect(result.title).toBe("Zażółć");
  });

  it("P2 reports unavailable, with no body, when sources leads out of the project", async () => {
    const outside = path.join(process.cwd(), "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "a.md"), "outside text", "utf-8");
    await fs.mkdir(project());
    await fs.symlink(outside, inProject("sources"));
    const result = await preview("a.md");
    expect(result.health).toBe("unavailable");
    expect("body" in result).toBe(false);
  });

  it("P3 reads a file of exactly the cap and refuses one byte more", async () => {
    await putSource("exact.md", "a".repeat(ONE_MIB));
    await putSource("over.md", "a".repeat(ONE_MIB + 1));
    const exact = await preview("exact.md");
    expect(exact.health).toBe("ok");
    expect(String(exact.body)).toHaveLength(ONE_MIB);
    expect((await preview("over.md")).health).toBe("unavailable");
  });

  it("P4 reports bytes that are not valid UTF-8 as unavailable", async () => {
    await putSource("bad.md", new Uint8Array([0xff, 0xfe, 0x41]));
    expect((await preview("bad.md")).health).toBe("unavailable");
  });

  it("P5 reports an unresolvable project as unavailable and a missing file in a real project as missing", async () => {
    expect((await preview("a.md", path.join(process.cwd(), "no-such-project"))).health).toBe("unavailable");
    await fs.mkdir(inProject("sources"), { recursive: true });
    expect((await preview("a.md")).health).toBe("missing");
  });
});

describe("the preview's one disk read, by argument", () => {
  it("A1 calls the confined read once with the root, the file, its directory and the cap, and nothing else", async () => {
    await putSource(NESTED_ID, NESTED_TEXT);
    primitive.calls.length = 0;
    await preview(NESTED_ID);
    expect(primitive.calls).toStrictEqual([
      [project(), inProject("sources", "papers", "a.md"), inProject("sources", "papers"), ONE_MIB],
    ]);
  });
});
