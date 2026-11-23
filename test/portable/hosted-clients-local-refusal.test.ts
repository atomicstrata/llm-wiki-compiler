/**
 * @file test/portable/hosted-clients-local-refusal.test.ts
 * @description The optional hosted-client contracts (retained originals, the
 * search tiers, federation) against a LOCAL directory: every method answers a
 * typed `capability_unsupported` refusal, and the CLI handlers refuse a
 * reference that is not a host URL before opening anything. No host is
 * started, contacted or provisioned: the test spies on `fetch` and expects
 * no call.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { projectOriginalsStatCommand } from "../../src/commands/project/originals-commands.js";
import { projectTiersSearchCommand } from "../../src/commands/project/tiers-commands.js";
import { FEDERATION_PROTOCOL_V2 } from "../../src/portable/federation/contracts.js";
import { openFederation } from "../../src/portable/federation/open.js";
import { ORIGINALS_PROTOCOL_V2 } from "../../src/portable/originals/contracts.js";
import { openOriginalsProject } from "../../src/portable/originals/open.js";
import { TIERS_PROTOCOL_V2 } from "../../src/portable/tiered/contracts.js";
import { openTieredProject } from "../../src/portable/tiered/open.js";

const LOCAL = { kind: "local-os" } as const;
let root = "";
let fetchCalls = 0;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "llmwiki-hosted-local-"));
  fetchCalls = 0;
  // A refusing offline double: Bun's `typeof fetch` also declares `preconnect`, which this double deliberately lacks.
  vi.spyOn(globalThis, "fetch").mockImplementation((async () => { fetchCalls += 1; throw new Error("no host may be contacted"); }) as typeof fetch & (() => Promise<never>));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("hosted-client contracts refuse on a local directory", () => {
  it("retained originals: a typed refusal naming the capability", async () => {
    const client = openOriginalsProject({ project: { localRoot: root }, credential: LOCAL, protocols: [ORIGINALS_PROTOCOL_V2] });
    expect(await client.stat("a.pdf")).toMatchObject({ kind: "refused", code: "capability_unsupported" });
  });

  it("search tiers: a typed refusal naming the capability", async () => {
    const session = openTieredProject({ project: { localRoot: root }, credential: LOCAL, protocols: [TIERS_PROTOCOL_V2] });
    expect(await session.tiers.negotiate()).toMatchObject({ kind: "refused", code: "capability_unsupported" });
  });

  it("federation: a typed refusal", async () => {
    const session = openFederation({ receiver: { localRoot: root }, federationId: "f", shards: [], protocols: [FEDERATION_PROTOCOL_V2] });
    expect(await session.quality()).toMatchObject({ kind: "refused", code: "capability_unsupported" });
  });

  it("contacts no host and writes nothing", async () => {
    await openOriginalsProject({ project: { localRoot: root }, credential: LOCAL, protocols: [ORIGINALS_PROTOCOL_V2] }).stat("a.pdf");
    expect(fetchCalls).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });
});

describe("hosted-client commands refuse a reference that is not a host URL", () => {
  it.each([
    ["project originals stat", () => projectOriginalsStatCommand("a.pdf", { project: root })],
    ["project tiers search", () => projectTiersSearchCommand("query", { project: root } as never)],
  ])("%s exits non-zero without contacting anything", async (_label, run) => {
    expect(await run()).not.toBe(0);
    expect(fetchCalls).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });
});
