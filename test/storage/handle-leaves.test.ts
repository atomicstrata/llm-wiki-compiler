/**
 * @file test/storage/handle-leaves.test.ts
 * @description The two handle-holding reads in
 * `src/storage/disk-handle-leaves.ts`, on real entries in a temp directory.
 * Nothing is mocked here: every expectation is a FIXED outcome written down
 * from what the legacy profile loader and the product-package member check did
 * inline before the move, never a comparison with the primitive a function
 * happens to call.
 *
 * What the capped text read must keep apart is the point of the first half: a
 * failed open (and why), a leaf over the cap (and its size), and the text,
 * decoded leniently. The second half is the confined digest check's four
 * answers, including the single-link rule its caller turns on. The last is the
 * same check keeping its bytes: the same answer for every one of those leaves,
 * and with `matches` the exact bytes the digest was taken over.
 */

import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  checkConfinedLeafDigest, readConfinedLeafDigest, readLeafTextNoFollowCapped,
} from "../../src/storage/disk-handle-leaves.js";

const BYTES = Buffer.from("member bytes, exactly these\n");
const CAP = 16;

let root: string;
const members = (): string => path.join(root, "members");
const member = (name = "leaf"): string => path.join(members(), name);
const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const expected = (bytes: Buffer = BYTES) => ({ sha256Hex: sha256Hex(bytes), byteCount: bytes.byteLength });
const errorCode = (read: Awaited<ReturnType<typeof readLeafTextNoFollowCapped>>): unknown =>
  read.kind === "not-opened" ? (read.error as NodeJS.ErrnoException).code : read.kind;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "llmwiki-handle-leaves-")));
  await mkdir(members());
  await writeFile(member(), BYTES);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("readLeafTextNoFollowCapped", () => {
  it("returns the text of a regular leaf, and reads a leaf of exactly the cap", async () => {
    await writeFile(member("at-cap"), "x".repeat(CAP));
    expect(await readLeafTextNoFollowCapped(member(), 1024)).toEqual({ kind: "text", text: BYTES.toString("utf-8") });
    expect(await readLeafTextNoFollowCapped(member("at-cap"), CAP)).toEqual({ kind: "text", text: "x".repeat(CAP) });
  });

  it("reports a leaf one byte over the cap as oversize, with its real size", async () => {
    await writeFile(member("over"), "x".repeat(CAP + 1));
    expect(await readLeafTextNoFollowCapped(member("over"), CAP)).toEqual({ kind: "oversize", size: CAP + 1 });
  });

  it("keeps a failed open apart, carrying the raw error for each reason", async () => {
    await symlink(member(), member("linked"));
    expect(errorCode(await readLeafTextNoFollowCapped(member("missing"), CAP))).toBe("ENOENT");
    expect(errorCode(await readLeafTextNoFollowCapped(member("linked"), 1024))).toBe("ELOOP");
    expect(errorCode(await readLeafTextNoFollowCapped(members(), 1024))).toBe("ENOFOLLOW");
  });

  it("decodes leniently: bytes that are not UTF-8 become replacement characters, not a refusal", async () => {
    await writeFile(member("blob"), Buffer.from([0x61, 0xff, 0x62]));
    expect(await readLeafTextNoFollowCapped(member("blob"), CAP)).toEqual({ kind: "text", text: "a�b" });
  });
});

describe("checkConfinedLeafDigest", () => {
  it("matches a leaf holding exactly the expected bytes", async () => {
    expect(await checkConfinedLeafDigest(root, member(), members(), expected())).toBe("matches");
  });

  it("differs for other bytes of the same length, and for another byte count", async () => {
    const sameLength = Buffer.from(BYTES);
    sameLength[0] ^= 0xff;
    await writeFile(member("swapped"), sameLength);
    expect(await checkConfinedLeafDigest(root, member("swapped"), members(), expected())).toBe("differs");
    expect(await checkConfinedLeafDigest(root, member(), members(), { ...expected(), byteCount: BYTES.byteLength + 1 })).toBe("differs");
    expect(await checkConfinedLeafDigest(root, member(), members(), { ...expected(), byteCount: BYTES.byteLength - 1 })).toBe("differs");
  });

  it("answers absent for no leaf and unavailable for a link at the leaf", async () => {
    await symlink(member(), member("linked"));
    expect(await checkConfinedLeafDigest(root, member("missing"), members(), expected())).toBe("absent");
    expect(await checkConfinedLeafDigest(root, member("linked"), members(), expected())).toBe("unavailable");
  });

  it("refuses a second hard link only when the caller requires a single link", async () => {
    await link(member(), path.join(root, "second-name"));
    expect(await checkConfinedLeafDigest(root, member(), members(), expected(), { requireSingleLink: true })).toBe("unavailable");
    expect(await checkConfinedLeafDigest(root, member(), members(), expected())).toBe("matches");
  });

  it("answers unavailable when the leaf's parent directory is a link", async () => {
    await symlink(members(), path.join(root, "alias"));
    const viaAlias = path.join(root, "alias", "leaf");
    expect(await checkConfinedLeafDigest(root, viaAlias, path.join(root, "alias"), expected())).toBe("unavailable");
  });
});

describe("readConfinedLeafDigest", () => {
  it("answers exactly as the check for each of its leaves, and returns bytes only with matches", async () => {
    const sameLength = Buffer.from(BYTES);
    sameLength[0] ^= 0xff;
    await writeFile(member("swapped"), sameLength);
    await symlink(member(), member("linked"));
    const cases: [string, ReturnType<typeof expected>][] = [
      [member(), expected()], [member("swapped"), expected()], [member(), { ...expected(), byteCount: BYTES.byteLength + 1 }],
      [member("missing"), expected()], [member("linked"), expected()],
    ];
    for (const [leaf, want] of cases) {
      const read = await readConfinedLeafDigest(root, leaf, members(), want, { requireSingleLink: true });
      expect(read.kind).toBe(await checkConfinedLeafDigest(root, leaf, members(), want, { requireSingleLink: true }));
    }
    expect(await readConfinedLeafDigest(root, member(), members(), expected())).toEqual({ kind: "matches", bytes: BYTES });
    expect(await readConfinedLeafDigest(root, member("swapped"), members(), expected())).toEqual({ kind: "differs" });
  });

  it("keeps every byte of a leaf longer than one streamed chunk, and refuses a second hard link when asked", async () => {
    const large = Buffer.from(Array.from({ length: 2 * 1024 * 1024 + 7 }, (_, index) => index % 251));
    await writeFile(member("large"), large);
    expect(await readConfinedLeafDigest(root, member("large"), members(), expected(large))).toEqual({ kind: "matches", bytes: large });
    await link(member(), path.join(root, "second-name"));
    expect(await readConfinedLeafDigest(root, member(), members(), expected(), { requireSingleLink: true })).toEqual({ kind: "unavailable" });
  });
});
