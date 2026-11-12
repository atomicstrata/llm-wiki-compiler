/**
 * @file test/storage/entity-scan-legacy.test.ts
 * @description The shared entity scan (`scanEntityDir`) on real files in a
 * temp directory, for five outcomes the existing collector tests do not state.
 * The file says what moving that scan's disk calls behind a read binding must
 * not change, so it is run byte for byte against the source both before and
 * after that change.
 *
 * Each case records behaviour as it is, including behaviour a hardening pass
 * might want to change: a link inside the directory keeps its own stem but
 * reports its target's path; a regular file where the directory should be is
 * `missing`, not `invalid`; an entry that cannot be read is dropped without a
 * word; and bytes that are not valid UTF-8 are kept, not refused. None of
 * these is endorsed here. They are pinned so a refactor cannot move them.
 *
 * Nothing is injected. Every project used here is a directory this fixture
 * creates under its own temp root.
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { scanEntityDir, type EntityDirScan } from "../../src/wiki/collect.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const DIR = "wiki/notes";
const REPLACEMENT = "�";
const PAGE = (title: string): string => `---\ntitle: ${title}\n---\n\nBody of ${title}.\n`;
useTempRoot();

/** The project these cases scan: a directory inside the fixture's own temp root. */
const project = (): string => path.join(process.cwd(), "project");
const entry = (name: string): string => path.join(project(), DIR, name);

/** Write one entry of the scanned directory, creating the directory. */
async function put(name: string, content: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.join(project(), DIR), { recursive: true });
  await fs.writeFile(entry(name), content);
}

/** The scan's status and stems, stems sorted because listing order is the backend's. */
const outline = (scan: EntityDirScan): { status: string; stems: string[] } => (
  { status: scan.dirStatus, stems: scan.scans.map((found) => found.stem).sort() }
);

describe("the entity scan on real files, as it behaves today", () => {
  it("L1 gives a link inside the directory its own stem and its target's resolved path", async () => {
    await put("alpha.md", PAGE("Alpha"));
    await fs.symlink(entry("alpha.md"), entry("inside.md"));
    const target = await fs.realpath(entry("alpha.md"));
    const scan = await scanEntityDir(project(), DIR);
    expect(scan.dirStatus).toBe("ok");
    expect(scan.scans.map((found) => [found.stem, found.filePath]).sort()).toEqual([["alpha", target], ["inside", target]]);
    expect(scan.scans.map((found) => found.frontmatter.title)).toEqual(["Alpha", "Alpha"]);
  });

  it("L2 reports a regular file where the directory should be as missing, not invalid", async () => {
    await fs.mkdir(path.join(project(), "wiki"), { recursive: true });
    await fs.writeFile(path.join(project(), DIR), "a file, not a directory");
    expect(await scanEntityDir(project(), DIR)).toEqual({ scans: [], dirStatus: "missing" });
  });

  it("L3 drops a directory named like a page without a word, with bodies and without", async () => {
    await put("ok.md", PAGE("OK"));
    await fs.mkdir(entry("x.md"));
    expect(outline(await scanEntityDir(project(), DIR))).toEqual({ status: "ok", stems: ["ok"] });
    expect(outline(await scanEntityDir(project(), DIR, { includeBody: false }))).toEqual({ status: "ok", stems: ["ok"] });
  });

  it("L4 reports an unresolvable project as invalid and skips a dangling entry in a real one", async () => {
    const nowhere = path.join(process.cwd(), "no-such-project");
    expect(await scanEntityDir(nowhere, DIR)).toEqual({ scans: [], dirStatus: "invalid" });
    await put("ok.md", PAGE("OK"));
    await fs.symlink(entry("nowhere.md"), entry("gone.md"));
    expect(outline(await scanEntityDir(project(), DIR))).toEqual({ status: "ok", stems: ["ok"] });
  });

  it("L5 keeps a page whose body is not valid UTF-8, with replacement characters", async () => {
    const bytes = Buffer.concat([Buffer.from("---\ntitle: Bytes\n---\n\nbad "), Buffer.from([0xff, 0xfe]), Buffer.from(" tail\n")]);
    await put("bytes.md", bytes);
    const scan = await scanEntityDir(project(), DIR);
    expect(outline(scan)).toEqual({ status: "ok", stems: ["bytes"] });
    expect(scan.scans[0]!.frontmatter.title).toBe("Bytes");
    expect(scan.scans[0]!.body).toContain(`bad ${REPLACEMENT}${REPLACEMENT} tail`);
    expect(outline(await scanEntityDir(project(), DIR, { includeBody: false }))).toEqual({ status: "ok", stems: ["bytes"] });
  });
});
