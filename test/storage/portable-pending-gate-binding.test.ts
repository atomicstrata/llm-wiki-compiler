/**
 * @file test/storage/portable-pending-gate-binding.test.ts
 * @description The pending-portable-intent gate leg as ONE body,
 * `portableGateBlockFrom(PortableGateProjectReads, PortableGateHostReads)`, with
 * `portableGateBlock(root)` delegating over the local bindings
 * (`localPortableGateProjectReads`, `localPortableGateHostReads`).
 *
 * HOW IT IS BUILT. Disk cases register a REAL project with
 * `registerLocalProject` (test support: public builds ship no registration),
 * under a host control root redirected into a temporary directory through
 * `XDG_CONFIG_HOME` (the per-user default is never touched), and
 * compare the root form with the body over the local bindings. Memory cases hand
 * the body scripted collaborators, the supported record being the real one just
 * registered; they prove the body's order, short-circuits and refusals, not the
 * ledger parsing or the registry lookup, which stay in the local bindings and are
 * covered by the disk cases here.
 */

import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";
import type { ProjectControlRecord } from "../../src/portable/host/control.js";
import { registerLocalProject } from "../fixtures/portable-local-control.js";
import * as localRegistry from "../../src/portable/host/local-registry.js";
import { localControlRoot, projectRecordFile } from "../../src/portable/host/local-registry.js";
import {
  localPortableGateHostReads, localPortableGateProjectReads, portableGateBlock, portableGateBlockFrom,
  type PortableGateHostReads, type PortableGateProjectReads,
} from "../../src/portable/host/pending-gate.js";
import * as diskIntent from "../../src/portable/store/disk-intent.js";
import { ledgerFile } from "../../src/portable/store/disk-layout.js";
import { createWikiCore } from "../../src/sdk/core.js";

let base = "";
let registered = "";
let record: ProjectControlRecord;
beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "portable-pending-gate-")));
  stubEnv("XDG_CONFIG_HOME", path.join(base, "xdg"));
  registered = path.join(base, "registered");
  await mkdir(registered);
  record = (await registerLocalProject(registered)).record;
  restoreEnv();
});
afterEach(() => { vi.restoreAllMocks(); restoreEnv(); });
afterAll(() => rm(base, { recursive: true, force: true }));

/** The root form and the body over the local bindings, under the temporary host control root. */
async function bothForms(root: string): Promise<unknown[]> {
  stubEnv("XDG_CONFIG_HOME", path.join(base, "xdg"));
  return [await portableGateBlock(root), await portableGateBlockFrom(localPortableGateProjectReads(root), localPortableGateHostReads(root))];
}

interface Script { dir?: boolean; intents?: string[]; projectId?: string | null | Error; record?: ProjectControlRecord | null | Error }
/** Scripted collaborators; every call logged in order. */
function memory(script: Script, log: string[]): [PortableGateProjectReads, PortableGateHostReads] {
  const answer = <T>(value: T | Error): T => { if (value instanceof Error) throw value; return value; };
  return [{
    hasPortableDirectory: async () => { log.push("dir"); return script.dir ?? true; },
    unresolvedIntents: async () => { log.push("intents"); return script.intents ?? []; },
  }, {
    registeredProjectId: async () => { log.push("project-id"); return answer(script.projectId === undefined ? record.projectId : script.projectId); },
    readProjectRecord: async () => { log.push("record"); return answer(script.record === undefined ? record : script.record); },
  }];
}

describe("the portable pending gate: one body, project and host collaborators", () => {
  it("G1 answers alike through the root form and the body over the local bindings on real projects", async () => {
    const bare = path.join(base, "bare");
    await mkdir(bare);
    expect(await bothForms(bare)).toEqual([null, null]);
    expect(await bothForms(registered)).toEqual([null, null]);
    restoreEnv();
    const file = projectRecordFile(path.join(base, "xdg", "llmwiki", "host-control"), record.projectId);
    const stored = await readFile(file, "utf8");
    await writeFile(file, JSON.stringify({ ...JSON.parse(stored), formatVersion: 2 }));
    expect(await bothForms(registered)).toEqual(["unsupported-registration", "unsupported-registration"]);
    await writeFile(file, stored);
  });

  it("G2 reads nothing past an absent directory, and refuses an unresolved intent before and regardless of any host read", async () => {
    const pass = async (script: Script) => { const log: string[] = []; return [await portableGateBlockFrom(...memory(script, log)), log]; };
    expect(await pass({ dir: false })).toEqual([null, ["dir"]]);
    expect(await pass({ intents: ["op_1"], projectId: new Error("host unreachable") })).toEqual(["unresolved-intent", ["dir", "intents"]]);
    expect(await pass({ projectId: null })).toEqual([null, ["dir", "intents", "project-id"]]);
    expect(await pass({})).toEqual([null, ["dir", "intents", "project-id", "record"]]);
  });

  it("G3 keeps the D24 refusal for an unsupported, missing or unreadable record, and the original exception boundaries", async () => {
    const block = (script: Script) => portableGateBlockFrom(...memory(script, []));
    const unsupported = { ...record, requiredFeatures: [...record.requiredFeatures, "a-future-feature"] };
    expect(await Promise.all([block({ record: unsupported }), block({ record: null }), block({ record: new Error("unreadable") })]))
      .toEqual(["unsupported-registration", "unsupported-registration", "unsupported-registration"]);
    await expect(block({ projectId: new Error("registry unreadable") })).rejects.toThrow("registry unreadable");
    const [project, host] = memory({}, []);
    const syncThrow: PortableGateHostReads = { ...host, readProjectRecord: () => { throw new Error("control root unresolvable"); } };
    await expect(portableGateBlockFrom(project, syncThrow)).rejects.toThrow("control root unresolvable");
  });

  it("G4 makes no ambient read from the body over memory collaborators, while the root form reaches each incumbent", async () => {
    const spies = [vi.spyOn(diskIntent, "unresolvedDiskIntents"), vi.spyOn(localRegistry, "registeredProjectId"), vi.spyOn(localRegistry, "readJsonFile")];
    await portableGateBlockFrom(...memory({}, []));
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    stubEnv("XDG_CONFIG_HOME", path.join(base, "xdg"));
    expect([await portableGateBlock(registered), localControlRoot()]).toEqual([null, path.join(base, "xdg", "llmwiki", "host-control")]);
    expect(spies.map((spy) => spy.mock.calls.length > 0)).toEqual([true, true, true]);
  });
});

/**
 * G5, end to end through the public SDK: the composition the bodies above do
 * not show. An unregistered project's lock-free source writers stay lock-free;
 * a registered project's are refused while a publication intent is unresolved
 * and work again once it is settled. The intent and its close are planted as
 * the ledger records the gate reads (no publication is run: public builds ship
 * none), and removed afterwards so the shared registered project stays clean.
 */
describe("the registered-project gate through createWikiCore", () => {
  it("G5 leaves an unregistered project's source writers lock-free", async () => {
    const plain = path.join(base, "plain");
    const core = createWikiCore({ root: plain });
    const saved = await core.ingestText({ title: "Plain Note", text: "Body.\n" });
    expect(await readdir(path.join(plain, ".llmwiki")).catch(() => [])).not.toContain("lock");
    expect(await core.deleteSource(saved.filename)).toBe(true);
  });

  it("G5 refuses ingest and source delete while an intent is unresolved, then allows them once it is closed", async () => {
    stubEnv("XDG_CONFIG_HOME", path.join(base, "xdg"));
    const core = createWikiCore({ root: registered });
    const kept = await core.ingestText({ title: "Kept Note", text: "Kept.\n" });
    const plantRecord = async (kind: "intents" | "closed") => {
      await mkdir(path.dirname(path.join(registered, ledgerFile(kind, "op_g5"))), { recursive: true });
      await writeFile(path.join(registered, ledgerFile(kind, "op_g5")), "{}");
    };
    try {
      await plantRecord("intents");
      const blocked = { name: "PortableRecoveryBlockingError" };
      await expect(core.ingestText({ title: "Late Note", text: "Late.\n" })).rejects.toMatchObject(blocked);
      await expect(core.deleteSource(kept.filename)).rejects.toMatchObject(blocked);
      expect(await readFile(path.join(registered, "sources", kept.filename), "utf8")).toContain("Kept.");
      await plantRecord("closed");
      expect((await core.ingestText({ title: "Late Note", text: "Late.\n" })).filename).toContain("late-note");
      expect(await core.deleteSource(kept.filename)).toBe(true);
    } finally {
      await rm(path.join(registered, ".llmwiki", "portable", "ledger"), { recursive: true, force: true });
      await rm(path.join(registered, "sources"), { recursive: true, force: true });
    }
  });
});
