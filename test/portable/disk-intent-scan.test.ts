/**
 * @file test/portable/disk-intent-scan.test.ts
 * @description Focused regression tests of the intent-ledger scan (CP189, the
 * CP188 P2-1 repair): `unresolvedDiskIntents` must classify EVERY entry of
 * `.llmwiki/portable/ledger/intents/`.
 *
 * A crash inside the durable create-only writer can leave `<id>.json.tmp` or
 * `<id>.json.writing` beside (or instead of) the canonical `<id>.json`. Those
 * leftovers are not intents: before this repair one became a phantom
 * "unresolved" id that recovery and resolve could never settle, blocking every
 * portable step and every legacy mutation. Now a canonical record is decided
 * first (so an id that itself ends in `.json.tmp` stays a record), an exact
 * leftover is ignored untouched, and anything else refuses by name. The legacy
 * pending gate is exercised over the real local project reads with explicit
 * fake host reads, never the default control state.
 *
 * STATUS: UNRUN when written (CP189). Every fixture is a fresh directory under
 * the test process's (redirected) temp root, removed afterwards; no store,
 * host, project, compiler, model, listener or subprocess is used.
 */

import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { PortableRefusal } from "../../src/portable/errors.js";
import { REQUIRED_FEATURES, type ProjectControlRecord } from "../../src/portable/host/control.js";
import { localPortableGateProjectReads, portableGateBlockFrom, type PortableGateHostReads } from "../../src/portable/host/pending-gate.js";
import { unresolvedDiskIntents } from "../../src/portable/store/disk-intent.js";
import { ledgerDir } from "../../src/portable/store/disk-layout.js";

let base = "";
let root = "";

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), "llmwiki-intent-scan-")));
  root = path.join(base, "project");
  await mkdir(root, { recursive: true });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** The fixture's intents directory, created on demand. */
async function intentsDir(): Promise<string> {
  const dir = path.join(root, ledgerDir("intents"));
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Write one regular file into the intents directory. */
async function putEntry(name: string, body = "{}"): Promise<string> {
  const file = path.join(await intentsDir(), name);
  await writeFile(file, body);
  return file;
}

/** Record a settling ledger file (`receipts` or `closed`) for `operationId`. */
async function settle(kind: "receipts" | "closed", operationId: string): Promise<void> {
  const dir = path.join(root, ledgerDir(kind));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${operationId}.json`), "{}");
}

/** Host reads naming a supported registration for this root: never the default control state. */
function registeredHost(): PortableGateHostReads {
  const record: ProjectControlRecord = {
    projectId: "prj_0a", tenant: "local", formatVersion: 1, requiredFeatures: [...REQUIRED_FEATURES], compartment: "prj_0a:default",
    policyRevision: 1, ticketRevision: 1, bindings: [], serviceGrants: [], tickets: [], canonicalRoot: root, hostIncarnation: "inc",
  };
  return { registeredProjectId: async () => record.projectId, readProjectRecord: async () => record };
}

describe("intent scan: canonical records and durable-temp leftovers", () => {
  it("finds nothing without a ledger and nothing in an empty one", async () => {
    expect(await unresolvedDiskIntents(root)).toEqual([]);
    await intentsDir();
    expect(await unresolvedDiskIntents(root)).toEqual([]);
  });

  it("ignores standalone durable-temp leftovers and leaves their bytes in place", async () => {
    await putEntry("op_a.json.tmp", "partial-a");
    await putEntry("op_b.json.writing", "partial-b");
    expect(await unresolvedDiskIntents(root)).toEqual([]);
    const dir = await intentsDir();
    expect((await readdir(dir)).sort()).toEqual(["op_a.json.tmp", "op_b.json.writing"]);
    expect([await readFile(path.join(dir, "op_a.json.tmp"), "utf8"), await readFile(path.join(dir, "op_b.json.writing"), "utf8")]).toEqual(["partial-a", "partial-b"]);
  });

  it("counts a canonical intent once beside its committed hard-link alias", async () => {
    const canonical = await putEntry("op_a.json");
    await link(canonical, path.join(await intentsDir(), "op_a.json.tmp"));
    expect(await unresolvedDiskIntents(root)).toEqual(["op_a"]);
  });

  it("keeps canonical ids that contain dots or a recognised suffix", async () => {
    for (const name of ["op_y.json.writing.json", "op.v2.json", "op_x.json.tmp.json"]) await putEntry(name);
    expect(await unresolvedDiskIntents(root)).toEqual(["op.v2", "op_x.json.tmp", "op_y.json.writing"]);
  });

  it("keeps the scan's plain name order", async () => {
    await putEntry("a.json");
    await putEntry("a-b.json");
    expect(await unresolvedDiskIntents(root)).toEqual(["a-b", "a"]);
  });
});

describe("intent scan: settled intents", () => {
  it("excludes an intent with a receipt or a recorded close, and keeps an open one", async () => {
    for (const name of ["op_done.json", "op_closed.json", "op_open.json"]) await putEntry(name);
    await settle("receipts", "op_done");
    await settle("closed", "op_closed");
    expect(await unresolvedDiskIntents(root)).toEqual(["op_open"]);
  });
});

describe("intent scan: anything else refuses by name", () => {
  it("refuses an unexpected regular file", async () => {
    await putEntry("notes.txt");
    await expect(unresolvedDiskIntents(root)).rejects.toThrow("notes.txt");
    await expect(unresolvedDiskIntents(root)).rejects.toBeInstanceOf(PortableRefusal);
  });

  it("refuses unsafe ids, as records and as leftovers", async () => {
    for (const name of [".hidden.json", ".x.json.tmp"]) {
      await rm(path.join(root, ".llmwiki"), { recursive: true, force: true });
      await putEntry(name);
      await expect(unresolvedDiskIntents(root)).rejects.toThrow(name);
    }
  });

  it("refuses directories even with a canonical or leftover name", async () => {
    for (const name of ["op_a.json", "op_b.json.tmp"]) {
      await rm(path.join(root, ".llmwiki"), { recursive: true, force: true });
      await mkdir(path.join(await intentsDir(), name));
      await expect(unresolvedDiskIntents(root)).rejects.toThrow(name);
    }
  });

  it("refuses symbolic links even with a canonical or leftover name", async () => {
    const target = path.join(base, "elsewhere.json");
    await writeFile(target, "{}");
    for (const name of ["op_c.json", "op_d.json.writing"]) {
      await rm(path.join(root, ".llmwiki"), { recursive: true, force: true });
      await symlink(target, path.join(await intentsDir(), name));
      await expect(unresolvedDiskIntents(root)).rejects.toThrow(name);
    }
  });
});

describe("legacy pending gate over the real project reads", () => {
  it("does not block on durable-temp leftovers alone", async () => {
    await putEntry("op_a.json.tmp");
    await putEntry("op_b.json.writing");
    expect(await portableGateBlockFrom(localPortableGateProjectReads(root), registeredHost())).toBeNull();
  });

  it("blocks on a true unresolved canonical intent", async () => {
    await putEntry("op_open.json");
    expect(await portableGateBlockFrom(localPortableGateProjectReads(root), registeredHost())).toBe("unresolved-intent");
  });

  it("fails closed on an entry that is not a record", async () => {
    await putEntry("stray.bin");
    await expect(portableGateBlockFrom(localPortableGateProjectReads(root), registeredHost())).rejects.toThrow("stray.bin");
  });
});
