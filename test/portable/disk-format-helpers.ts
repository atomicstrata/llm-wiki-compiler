/**
 * @file test/portable/disk-format-helpers.ts
 * @description Fixtures for the S2b registered-directory witnesses: a
 * temporary project registered in a temporary DEFAULT control root, so the
 * legacy mutation gate (which reads the default root) sees the same
 * registration the portable path does.
 *
 * Every project, control root and configuration directory here is created
 * under the system temporary directory and removed afterwards. Nothing touches
 * a real project or the user's configuration.
 */

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restoreEnv, stubEnv } from "../stubs.js";
import type { OperationIdentityRecordV1 } from "../../src/portable/contracts.js";
import { adoptFormat2, type AdoptionFaultStage, type AdoptionResult } from "../../src/portable/host/format-adoption.js";
import { DeterministicProvider, overrideOf } from "../helpers/deterministic-provider.js";
import { registerLocalProject } from "../../src/portable/host/local-control.js";
import { localControlRoot, projectRecordFile, readJsonFile } from "../../src/portable/host/local-registry.js";
import type { ProjectControlRecord } from "../../src/portable/host/control.js";
import { openLocalProject } from "../../src/portable/local.js";
import type { ProjectSession } from "../../src/portable/project/api.js";

/** The local host model of these fixtures: a test-only provider that THROWS on any call. Nothing here generates; a test that proposes must supply its own answers. */
const NO_MODEL = () => overrideOf(new DeterministicProvider());

/** A registered temporary project whose control state is in a temporary default root. */
export interface FormatFixture {
  root: string;
  controlRoot: string;
  projectId: string;
  open(): Promise<ProjectSession>;
  adopt(fault?: AdoptionFaultStage): Promise<AdoptionResult>;
  /** The control record as stored now. */
  record(): Promise<ProjectControlRecord>;
  cleanup(): Promise<void>;
}

/** Register a fresh temporary project. Point the default config root at a temporary directory first. */
export async function makeFormatFixture(): Promise<FormatFixture> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "llmwiki-s2b-")));
  stubEnv("XDG_CONFIG_HOME", path.join(base, "config"));
  const root = path.join(base, "project");
  await mkdir(root, { recursive: true });
  const controlRoot = localControlRoot();
  const { record } = await registerLocalProject(root, controlRoot);
  return {
    root, controlRoot, projectId: record.projectId,
    open: () => openLocalProject(root, { controlRoot, model: NO_MODEL }),
    adopt: (fault) => adoptFormat2(root, {
      controlRoot, faultForTest: (stage) => { if (stage === fault) throw new Error(`interrupted ${stage}`); },
    }),
    record: async () => (await readJsonFile<ProjectControlRecord>(projectRecordFile(controlRoot, record.projectId))) as ProjectControlRecord,
    cleanup: async () => { restoreEnv(); await rm(base, { recursive: true, force: true }); },
  };
}

/** The project-relative path of a ledger file. */
export function ledgerPath(fixture: FormatFixture, kind: string, name: string): string {
  return path.join(fixture.root, ".llmwiki", "portable", "ledger", kind, name);
}
