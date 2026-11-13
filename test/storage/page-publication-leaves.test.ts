/**
 * @file test/storage/page-publication-leaves.test.ts
 * @description What approval's destination checks do to disk once their reads
 * and existence tests go through the storage functions, pinned on a temp
 * directory as they behave TODAY.
 *
 * Two things are new at these call sites and are the only things tested here.
 * The target-unchanged precondition now passes a project-relative path to the
 * local reads binding, so the routing (default, queries, typed) and the root
 * form (absolute, relative) must still name the same file. The existence tests
 * now hand `leafPresent` a path split into parent and name, so the split must
 * be the identity for every normalized absolute path, short ones included.
 *
 * The link cases are records, not endorsements: the precondition read FOLLOWS
 * links and is not confined, so a dangling link counts as absent and a link to
 * a file outside the project is read through.
 *
 * The default page writer and the size-floor read are compared with the
 * primitives they wrap, on real directories, so what is pinned is what the
 * primitive does today and not an expectation of it. The writer is NOT
 * confined; the last case keeps that visible, because the page apply relies on
 * its own earlier confinement and a silent "fix" here would change behaviour.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { targetUnchangedSincePropose } from "../../src/commands/review-target-precondition.js";
import { sha256Text } from "../../src/connectors/hash.js";
import { leafPresent, readConfinedLeafText, writeLeafAtomicUnconfined } from "../../src/storage/disk-guarded-leaves.js";
import { checkTargetCollision } from "../../src/trust/checks.js";
import { atomicWrite } from "../../src/utils/atomic-write.js";
import { readConfinedLeaf } from "../../src/utils/confined-read.js";
import type { ReviewCandidate } from "../../src/utils/types.js";

const PAGE_TEXT = "---\ntitle: Alpha\n---\nbody\n";

/** The three ways a candidate names its destination, with where each must land. */
const ROUTES = [
  { route: "default", fields: {}, dir: "wiki/concepts" },
  { route: "queries", fields: { targetDirectory: "queries" as const }, dir: "wiki/queries" },
  { route: "typed", fields: { targetEntityType: "papers" }, dir: "wiki/papers" },
];

let base: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "llmwiki-pub-leaves-")));
  root = path.join(base, "project");
  await mkdir(root);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Only the fields the precondition reads; the rest of a candidate is irrelevant to it. */
function candidate(fields: Partial<ReviewCandidate>): ReviewCandidate {
  return { slug: "alpha", ...fields } as ReviewCandidate;
}

async function plantPage(relDir: string, text: string): Promise<void> {
  await mkdir(path.join(root, relDir), { recursive: true });
  await writeFile(path.join(root, relDir, "alpha.md"), text);
}

describe("target-unchanged precondition through the local reads binding", () => {
  const rootForms = [
    { form: "absolute", rootOf: () => root },
    { form: "relative", rootOf: () => path.relative(process.cwd(), root) },
  ];
  const cases = ROUTES.flatMap((r) => rootForms.map((f) => ({ ...r, ...f })));

  it.each(cases)("$route route, $form root: absence and hash outcomes", async ({ fields, dir, rootOf }) => {
    const at = rootOf();
    const absent = candidate({ ...fields, expectTargetAbsent: true });
    const pinned = candidate({ ...fields, expectedTargetHash: sha256Text(PAGE_TEXT) });
    expect(await targetUnchangedSincePropose(at, absent)).toBe(true);
    expect(await targetUnchangedSincePropose(at, pinned)).toBe(false);
    await plantPage(dir, PAGE_TEXT);
    expect(await targetUnchangedSincePropose(at, absent)).toBe(false);
    expect(await targetUnchangedSincePropose(at, pinned)).toBe(true);
    await plantPage(dir, `${PAGE_TEXT}edited\n`);
    expect(await targetUnchangedSincePropose(at, pinned)).toBe(false);
  });

  it("holds no precondition for a plain candidate and refuses contradictory ones", async () => {
    expect(await targetUnchangedSincePropose(root, candidate({}))).toBe(true);
    const both = candidate({ expectTargetAbsent: true, expectedTargetHash: sha256Text(PAGE_TEXT) });
    expect(await targetUnchangedSincePropose(root, both)).toBe(false);
  });

  it("counts a dangling link as absent and an unreadable target as changed", async () => {
    await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
    await symlink(path.join(base, "nowhere.md"), path.join(root, "wiki/concepts/alpha.md"));
    expect(await targetUnchangedSincePropose(root, candidate({ expectTargetAbsent: true }))).toBe(true);
    expect(await targetUnchangedSincePropose(root, candidate({ expectedTargetHash: sha256Text("") }))).toBe(false);
  });

  it("reads through a link to a file outside the project", async () => {
    await writeFile(path.join(base, "outside.md"), PAGE_TEXT);
    await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
    await symlink(path.join(base, "outside.md"), path.join(root, "wiki/concepts/alpha.md"));
    expect(await targetUnchangedSincePropose(root, candidate({ expectTargetAbsent: true }))).toBe(false);
    expect(await targetUnchangedSincePropose(root, candidate({ expectedTargetHash: sha256Text(PAGE_TEXT) }))).toBe(true);
  });
});

describe("existence tests on a path split into parent and name", () => {
  it("splits every normalized absolute path back into itself, short ones included", async () => {
    const shortest = path.join(path.parse(base).root, base.split(path.sep)[1]);
    const shapes = [shortest, root, path.join(root, "wiki/concepts/alpha.md"), path.join(root, "wiki/papers/a b.md")];
    for (const abs of shapes) expect(path.join(path.dirname(abs), path.basename(abs))).toBe(abs);
    expect(await leafPresent(path.dirname(shortest), path.basename(shortest))).toBe(true);
    expect(await leafPresent(path.dirname(root), path.basename(root))).toBe(true);
  });

  it("reports the collision check's three outcomes for a present, absent and unreachable target", async () => {
    const ctx = { root, targetPath: "wiki/concepts/alpha.md", body: PAGE_TEXT };
    expect((await checkTargetCollision(ctx)).message).toBe("target path is free");
    await plantPage("wiki/concepts", PAGE_TEXT);
    expect((await checkTargetCollision(ctx)).verdict).toBe("block");
    expect((await checkTargetCollision({ ...ctx, allowOverwrite: true })).verdict).toBe("pass");
    const underFile = { ...ctx, targetPath: "wiki/concepts/alpha.md/child.md" };
    expect((await checkTargetCollision(underFile)).message).toBe("target path is free");
  });
});

/** What one write did: how it settled, and what is at the leaf and behind a link afterwards. */
async function writeOutcome(write: (leaf: string, text: string) => Promise<void>, dir: string, shape: string): Promise<string[]> {
  const leaf = path.join(dir, shape === "missing parent" ? "gone/leaf.md" : "leaf.md");
  await mkdir(dir);
  await writeFile(path.join(dir, "linked.md"), "behind the link\n");
  if (shape === "existing leaf") await writeFile(leaf, "old\n");
  if (shape === "link leaf") await symlink(path.join(dir, "linked.md"), leaf);
  const settled = await write(leaf, "new\n").then(() => "resolved", (error: NodeJS.ErrnoException) => `${error.name}:${error.code}`);
  const kind = await lstat(leaf).then((stat) => (stat.isSymbolicLink() ? "link" : "file"), () => "absent");
  const text = kind === "absent" ? "" : await readFile(leaf, "utf-8");
  return [settled, kind, text, await readFile(path.join(dir, "linked.md"), "utf-8")];
}

describe("the default page writer and the size-floor read against their primitives", () => {
  it.each(["new leaf", "existing leaf", "missing parent", "link leaf"])("writes a %s exactly as atomicWrite with no options does", async (shape) => {
    const viaStorage = await writeOutcome(writeLeafAtomicUnconfined, path.join(base, "storage"), shape);
    const viaPrimitive = await writeOutcome((leaf, text) => atomicWrite(leaf, text), path.join(base, "primitive"), shape);
    expect(viaStorage).toEqual(viaPrimitive);
    if (shape === "new leaf" || shape === "existing leaf") expect(viaStorage.slice(0, 3)).toEqual(["resolved", "file", "new\n"]);
  });

  it("reads a regular, absent, linked and over-cap leaf exactly as readConfinedLeaf does", async () => {
    const dir = path.join(root, "wiki/concepts");
    await plantPage("wiki/concepts", PAGE_TEXT);
    await symlink(path.join(dir, "alpha.md"), path.join(dir, "linked.md"));
    const relativeRoot = path.relative(process.cwd(), root);
    const reads: Array<[string, string, number, string]> = [
      [root, "alpha.md", 1024, "ok"], [root, "absent.md", 1024, "absent"], [root, "linked.md", 1024, "unavailable"],
      [root, "alpha.md", PAGE_TEXT.length - 1, "unavailable"], [relativeRoot, "alpha.md", 1024, "ok"],
    ];
    for (const [from, name, cap, kind] of reads) {
      const viaStorage = await readConfinedLeafText(from, path.join(dir, name), dir, cap);
      expect(viaStorage).toEqual(await readConfinedLeaf(from, path.join(dir, name), dir, cap));
      expect(viaStorage.kind).toBe(kind);
    }
  });

  it("writes outside the project, because the writer itself confines nothing", async () => {
    const outside = path.join(base, "outside-the-project.md");
    await writeLeafAtomicUnconfined(outside, PAGE_TEXT);
    expect(await readFile(outside, "utf-8")).toBe(PAGE_TEXT);
  });
});
