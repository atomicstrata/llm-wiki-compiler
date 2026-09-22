/**
 * @file test/capability-providers/grant-store.test.ts
 * @description Operator-only grant persistence, exact binding, and honest
 * absent/unreadable/invalid read classification for Provider V2 Task 5.
 */
import path from "node:path";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  operatorGrantRequestDigest, projectGrantScopeDigest, writeOperatorGrant,
} from "../../src/capability-providers/authority/grants-resolve.js";
import { readProviderGrantState } from "../../src/capability-providers/authority/grants-store.js";
import type { ProviderGrantScopeV1 } from "../../src/capability-providers/authority/types.js";
import { parseBrokerId } from "../../src/capability-providers/ids.js";
import { installResolutionFixture, removeResolutionFixture, type ResolutionFixture } from "./resolution-fixture.js";

const fixtures: ResolutionFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map(removeResolutionFixture)));

describe("operator provider grant store", () => {
  it("writes one confirmed grant bound to canonical project, exact pin, and request digest", async () => {
    const fixture = await trackedFixture();
    const projectRoot = await projectDirectory(fixture, "project-one");
    const grant = emptyGrant();
    const projectDigest = await projectGrantScopeDigest(projectRoot);
    const confirmation = operatorGrantRequestDigest(fixture.pin, grant, projectDigest);
    await writeOperatorGrant(fixture.paths, {
      grantId: "grant-one", projectRoot, providerPin: fixture.pin, grant,
      confirmedGrantRequestDigest: confirmation, createdAt: "2026-07-18T12:00:00.000Z",
    });
    const read = await readProviderGrantState(fixture.paths);
    expect(read).toMatchObject({ kind: "ok", state: { grants: { "grant-one": {
      projectRealpathDigest: projectDigest,
      providerPinDigest: expect.stringMatching(/^sha256:/), grantRequestDigest: confirmation,
    } } } });
    if (process.platform !== "win32") {
      const file = path.join(fixture.paths.configRoot, "provider-grants.json");
      expect((await lstat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("does not write when confirmation differs from the exact grant request", async () => {
    const fixture = await trackedFixture();
    const projectRoot = await projectDirectory(fixture, "project-one");
    await expect(writeOperatorGrant(fixture.paths, {
      grantId: "grant-one", projectRoot, providerPin: fixture.pin, grant: emptyGrant(),
      confirmedGrantRequestDigest: fixture.pin.packageDigest, createdAt: "2026-07-18T12:00:00.000Z",
    })).rejects.toThrow(/confirmation/i);
    await expect(readProviderGrantState(fixture.paths)).resolves.toEqual({ kind: "absent" });
  });

  it("distinguishes absent, malformed, and unreadable grant state without creating reads", async () => {
    const fixture = await trackedFixture();
    await expect(readProviderGrantState(fixture.paths)).resolves.toEqual({ kind: "absent" });
    await writeFile(path.join(fixture.paths.configRoot, "provider-grants.json"), "{\"unknown\":true}\n");
    await expect(readProviderGrantState(fixture.paths)).resolves.toEqual({ kind: "invalid" });
    await rm(path.join(fixture.paths.configRoot, "provider-grants.json"));
    await symlink(path.join(fixture.root, "missing-grants"), path.join(fixture.paths.configRoot, "provider-grants.json"));
    await expect(readProviderGrantState(fixture.paths)).resolves.toEqual({ kind: "unreadable" });
  });

  it("binds copied project bytes to a different canonical realpath digest", async () => {
    const fixture = await trackedFixture();
    const first = await projectDirectory(fixture, "project-one");
    const second = await projectDirectory(fixture, "project-two");
    const grant = emptyGrant();
    const firstDigest = await projectGrantScopeDigest(first);
    const secondDigest = await projectGrantScopeDigest(second);
    expect(firstDigest).not.toBe(secondDigest);
    await expect(writeOperatorGrant(fixture.paths, {
      grantId: "grant-one", projectRoot: second, providerPin: fixture.pin, grant,
      confirmedGrantRequestDigest: operatorGrantRequestDigest(fixture.pin, grant, firstDigest),
      createdAt: "2026-07-18T12:00:00.000Z",
    })).rejects.toThrow(/confirmation/i);
  });

  it("rejects ill-formed Unicode before confirmation digesting", async () => {
    const fixture = await trackedFixture();
    const projectRoot = await projectDirectory(fixture, "project-one");
    const projectDigest = await projectGrantScopeDigest(projectRoot);
    expect(() => operatorGrantRequestDigest(fixture.pin, networkGrant("bad\ud800target"), projectDigest))
      .toThrow(/grant.*invalid/i);
  });

  it("decodes persisted grant state as fatal UTF-8", async () => {
    const fixture = await trackedFixture();
    const projectRoot = await projectDirectory(fixture, "project-one");
    const grant = networkGrant("\ufffd");
    const confirmation = operatorGrantRequestDigest(
      fixture.pin, grant, await projectGrantScopeDigest(projectRoot),
    );
    await writeOperatorGrant(fixture.paths, { grantId: "grant-one", projectRoot,
      providerPin: fixture.pin, grant, confirmedGrantRequestDigest: confirmation,
      createdAt: "2026-07-18T12:00:00.000Z" });
    const file = path.join(fixture.paths.configRoot, "provider-grants.json");
    const bytes = await readFile(file), marker = Buffer.from("\ufffd"), index = bytes.indexOf(marker);
    expect(index).toBeGreaterThanOrEqual(0);
    await writeFile(file, Buffer.concat([bytes.subarray(0, index), Buffer.from([0xff]), bytes.subarray(index + 3)]));
    await expect(readProviderGrantState(fixture.paths)).resolves.toEqual({ kind: "invalid" });
  });
});

async function trackedFixture(): Promise<ResolutionFixture> {
  const fixture = await installResolutionFixture();
  fixtures.push(fixture);
  return fixture;
}

async function projectDirectory(fixture: ResolutionFixture, name: string): Promise<string> {
  const directory = path.join(fixture.root, name);
  await mkdir(directory);
  return directory;
}

function emptyGrant(): ProviderGrantScopeV1 {
  const value = 1;
  return { schemaVersion: 1, authority: [], bounds: {
    structuredInputBytes: value, materializedInputFiles: value, materializedInputBytes: value,
    scratchFiles: value, scratchBytes: value, outputFiles: value, outputBytes: value,
    custodyScanBytes: value, custodyWallTimeMs: value, protocolFrames: value,
    protocolBytes: value, brokerRequests: value,
    mutatingEffects: value, wallTimeMs: value,
    cpuTimeMs: value, memoryBytes: value, processCount: value,
  } };
}

function networkGrant(target: string): ProviderGrantScopeV1 {
  return { ...emptyGrant(), authority: [{
    kind: "network.https", brokerId: parseBrokerId("https-broker"), operation: "request",
    target, method: "GET", credentialSlotId: null, credentialHandleId: null,
    effectClass: null, inputKind: null, toolId: null,
  }] };
}
