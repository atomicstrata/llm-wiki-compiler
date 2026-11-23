/**
 * @file test/portable/host-registration-recovery.test.ts
 * @description Focused regression tests of local registration against an
 * unusable existing registration (CP185).
 *
 * Registering an already-registered root is idempotent only while that
 * registration is usable. When the host identity that issued it is lost (its
 * `host.json` removed), registering again must REFUSE with accurate guidance —
 * it cannot recover the registration — instead of returning the stale record
 * as `created: false`. Nothing may be moved, deleted, restored or re-adopted:
 * the project record, its root mapping and the project's portable ledger
 * (which may hold unresolved intents) keep their exact bytes. A supported
 * format-2 registration stays idempotent; an adopting or unsupported one is
 * refused.
 *
 * STATUS: UNRUN when written (CP185). Every fixture lives in a fresh temporary
 * directory under the test process's (redirected) temp root, with an explicit
 * control root inside it: never the default per-user control state and never a
 * real wiki. Only the fixture's own `host.json` is removed to simulate the loss.
 * No model, provider, network, listener or subprocess is used.
 */

import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { PortableHostError } from "../../src/portable/errors.js";
import {
  ADOPTING_FEATURE, FORMAT2_FEATURES, REQUIRED_FEATURES, type HostControl, type ProjectControlRecord,
} from "../../src/portable/host/control.js";
import { assertUsableRegistration, LocalHostControl, registerLocalProject } from "../../src/portable/host/local-control.js";
import { hostIdentityFile, projectRecordFile, rootMappingFile } from "../../src/portable/host/local-registry.js";
import { PORTABLE_DIR } from "../../src/portable/store/disk-layout.js";

let base = "";
let root = "";
let controlRoot = "";

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), "llmwiki-registration-recovery-")));
  root = path.join(base, "project");
  controlRoot = path.join(base, "control");
  await mkdir(root, { recursive: true });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A pending-intent-like ledger record inside the project's portable directory. */
function sentinelPath(): string {
  return path.join(root, PORTABLE_DIR, "ledger", "intents", "op_sentinel.json");
}

/** Register the fixture root and plant the ledger sentinel; returns the record. */
async function registerWithLedger(): Promise<ProjectControlRecord> {
  const { record, created } = await registerLocalProject(root, controlRoot);
  expect(created).toBe(true);
  await mkdir(path.dirname(sentinelPath()), { recursive: true });
  await writeFile(sentinelPath(), JSON.stringify({ operationId: "op_sentinel", pending: true }));
  return record;
}

/** The exact bytes of the registration, its root mapping and the ledger sentinel. */
async function preservedBytes(projectId: string): Promise<string[]> {
  const files = [projectRecordFile(controlRoot, projectId), rootMappingFile(controlRoot, root), sentinelPath()];
  return Promise.all(files.map((file) => readFile(file, "utf8")));
}

/** Rewrite the fixture's own project record with `changes`, as a later binary or adoption would. */
async function rewriteRecord(record: ProjectControlRecord, changes: Partial<ProjectControlRecord>): Promise<void> {
  const control = await LocalHostControl.open(controlRoot);
  await control.saveProject({ ...record, ...changes });
}

describe("registration stays idempotent while the registration is usable", () => {
  it("returns the same format-1 project, unchanged, when registered again", async () => {
    const record = await registerWithLedger();
    const before = await preservedBytes(record.projectId);
    const again = await registerLocalProject(root, controlRoot);
    expect([again.created, again.record.projectId]).toEqual([false, record.projectId]);
    expect(await preservedBytes(record.projectId)).toEqual(before);
  });

  it("returns the same supported format-2 project, unchanged, when registered again", async () => {
    const record = await registerWithLedger();
    await rewriteRecord(record, { formatVersion: 2, requiredFeatures: [...REQUIRED_FEATURES, ...FORMAT2_FEATURES] });
    const before = await preservedBytes(record.projectId);
    const again = await registerLocalProject(root, controlRoot);
    expect([again.created, again.record.projectId, again.record.formatVersion]).toEqual([false, record.projectId, 2]);
    expect(await preservedBytes(record.projectId)).toEqual(before);
  });
});

describe("an unusable registration is refused, not reported as registered", () => {
  it("refuses an adoption left part-way through, changing nothing", async () => {
    const record = await registerWithLedger();
    await rewriteRecord(record, { formatVersion: 2, requiredFeatures: [...REQUIRED_FEATURES, ADOPTING_FEATURE] });
    const before = await preservedBytes(record.projectId);
    await expect(registerLocalProject(root, controlRoot)).rejects.toThrow(PortableHostError);
    expect(await preservedBytes(record.projectId)).toEqual(before);
  });

  it("refuses a registration requiring a feature this binary lacks, changing nothing", async () => {
    const record = await registerWithLedger();
    await rewriteRecord(record, { requiredFeatures: [...REQUIRED_FEATURES, "a-future-feature"] });
    const before = await preservedBytes(record.projectId);
    await expect(registerLocalProject(root, controlRoot)).rejects.toThrow("newer portable format");
    expect(await preservedBytes(record.projectId)).toEqual(before);
  });
});

describe("a lost host identity is refused with accurate guidance, and nothing is touched", () => {
  it("re-registering refuses instead of returning the stale record", async () => {
    const record = await registerWithLedger();
    const before = await preservedBytes(record.projectId);
    await unlink(hostIdentityFile(controlRoot));
    await expect(registerLocalProject(root, controlRoot)).rejects.toThrow("registering again cannot recover it");
    expect(await preservedBytes(record.projectId)).toEqual(before);
    const control = await LocalHostControl.open(controlRoot);
    expect((await control.projectForRoot(root))?.projectId).toBe(record.projectId);
  });

  it("the open-time check refuses the mismatch and points only to a matching verified backup", async () => {
    const record = await registerWithLedger();
    await unlink(hostIdentityFile(controlRoot));
    const control = await LocalHostControl.open(controlRoot);
    const stale = await control.projectForRoot(root);
    expect(stale?.hostIncarnation).toBe(record.hostIncarnation);
    expect(() => assertUsableRegistration(stale!, control)).toThrow("verified backup that matches");
    expect(() => assertUsableRegistration(stale!, control)).not.toThrow("register it again");
  });
});

/** A synthetic supported format-1 record issued by `incarnation`. */
function recordFrom(incarnation: string, changes: Partial<ProjectControlRecord> = {}): ProjectControlRecord {
  return {
    projectId: "prj_0a", tenant: "local", formatVersion: 1, requiredFeatures: [...REQUIRED_FEATURES], compartment: "prj_0a:default",
    policyRevision: 1, ticketRevision: 1, bindings: [], serviceGrants: [], tickets: [], canonicalRoot: "/fixture",
    hostIncarnation: incarnation, ...changes,
  };
}

describe("assertUsableRegistration on its own", () => {
  const control = { incarnation: "inc-current" } as unknown as HostControl;

  it("accepts a supported registration issued by this host identity", () => {
    expect(() => assertUsableRegistration(recordFrom("inc-current"), control)).not.toThrow();
  });

  it("refuses another identity's registration, naming that identity", () => {
    expect(() => assertUsableRegistration(recordFrom("inc-lost"), control)).toThrow("host identity inc-lost");
  });

  it("refuses an unsupported registration before comparing identities", () => {
    const unsupported = recordFrom("inc-lost", { formatVersion: 2, requiredFeatures: [...REQUIRED_FEATURES] });
    expect(() => assertUsableRegistration(unsupported, control)).toThrow("newer portable format");
  });
});
