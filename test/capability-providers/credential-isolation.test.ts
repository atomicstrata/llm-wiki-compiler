/**
 * @file test/capability-providers/credential-isolation.test.ts
 * @description Opaque credential-handle, closed source registry, single-broker
 * materialization, and multi-surface secret-reflection tests.
 */
import path from "node:path";
import { lstat, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNoCredentialReflection, createCredentialRegistry, readCredentialRegistryState,
  resolveCredentialHandle, takeCredentialBytesForBroker, writeOperatorCredentialRegistry,
} from "../../src/capability-providers/authority/credentials.js";
import { parseBrokerId } from "../../src/capability-providers/ids.js";
import type {
  CredentialHandleV1, ProviderVisibleCredentialSurfacesV1,
} from "../../src/capability-providers/authority/types.js";
import {
  installResolutionFixture, removeResolutionFixture, type ResolutionFixture,
} from "./resolution-fixture.js";

const SECRET = "canary-secret-42/+";
const BROKER = parseBrokerId("https-broker");
const SECRET_VARIABLE = "LLMWIKI_TEST_PROVIDER_TASK5_SECRET";
const PREVIOUS_SECRET = process.env[SECRET_VARIABLE];
const fixtures: ResolutionFixture[] = [];

beforeEach(() => { process.env[SECRET_VARIABLE] = SECRET; });
afterEach(() => {
  if (PREVIOUS_SECRET === undefined) delete process.env[SECRET_VARIABLE];
  else process.env[SECRET_VARIABLE] = PREVIOUS_SECRET;
});
afterEach(async () => Promise.all(fixtures.splice(0).map(removeResolutionFixture)));

describe("provider credential isolation", () => {
  it("stores descriptors only and materializes an environment secret for one exact broker", async () => {
    const registry = createCredentialRegistry([environmentHandle()]);
    expect(JSON.stringify(registry)).not.toContain(SECRET);
    const access = await resolveCredentialHandle(registry, "api-token", "credential-one", BROKER);
    expect(JSON.stringify(access)).not.toContain(SECRET);
    expect((await takeCredentialBytesForBroker(access, BROKER)).toString()).toBe(SECRET);
    await expect(takeCredentialBytesForBroker(access, BROKER)).rejects.toThrow(/unavailable/i);
  });

  it("refuses another broker and rejects source kinds outside the closed registry", async () => {
    const registry = createCredentialRegistry([environmentHandle()]);
    await expect(resolveCredentialHandle(registry, "api-token", "credential-one", parseBrokerId("model-broker")))
      .rejects.toThrow(/credential.*missing|unavailable/i);
    await expect(resolveCredentialHandle(registry, "other-slot", "credential-one", BROKER))
      .rejects.toThrow(/credential.*missing/i);
    expect(() => createCredentialRegistry([{ ...environmentHandle(), source: {
      kind: "file", path: "/tmp/secret",
    } } as unknown as CredentialHandleV1])).toThrow(/credential.*invalid/i);
  });

  it.each(surfaceCases())("fails closed when a supported encoding reaches $name", ({ surface, value }) => {
    const secret = Buffer.from(SECRET);
    let caught: unknown;
    try { assertNoCredentialReflection([secret], surfaces(surface, value)); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toBe("Error: credential reflection detected");
    expect(String(caught)).not.toContain(SECRET);
  });

  it("accepts clean provider-visible surfaces without retaining secret bytes", () => {
    expect(() => assertNoCredentialReflection([Buffer.from(SECRET)], surfaces("status", "clean")))
      .not.toThrow();
  });

  it("scans exact binary surfaces without treating clean bytes as invalid", () => {
    expect(() => assertNoCredentialReflection(
      [Buffer.from(SECRET)], surfaces("frames", Buffer.from("clean\u0000binary")),
    )).not.toThrow();
    expect(() => assertNoCredentialReflection(
      [Buffer.from(SECRET)], surfaces("frames", Buffer.from(`prefix-${SECRET}-suffix`)),
    )).toThrow(/reflection/i);
  });

  it.each(["lower", "upper"] as const)("detects a fully byte-percent-encoded secret (%s)", (form) => {
    const octets = Buffer.from(SECRET).toString("hex").match(/../g)!;
    const encoded = octets.map((octet) => `%${form === "upper" ? octet.toUpperCase() : octet}`).join("");
    expect(() => assertNoCredentialReflection(
      [Buffer.from(SECRET)], surfaces("urls", encoded),
    )).toThrow(/reflection/i);
  });

  it("detects standard URI and form representations", () => {
    const secret = Buffer.from("a b+c/credential");
    const uri = encodeURIComponent(secret.toString());
    const form = new URLSearchParams([["value", secret.toString()]]).toString().slice(6);
    expect(() => assertNoCredentialReflection([secret], surfaces("urls", uri))).toThrow(/reflection/i);
    expect(() => assertNoCredentialReflection([secret], surfaces("urls", form))).toThrow(/reflection/i);
  });

  it("detects mixed raw and percent-encoded secret bytes", () => {
    const secret = Buffer.from("canary-secret-42/+");
    expect(() => assertNoCredentialReflection(
      [secret], surfaces("urls", "%63anary-secret-42%2F%2B"),
    )).toThrow(/reflection/i);
  });

  it("detects mixed form and raw secret bytes", () => {
    const secret = Buffer.from("a b+c/credential");
    expect(() => assertNoCredentialReflection(
      [secret], surfaces("urls", "a+b%2Bc/credential"),
    )).toThrow(/reflection/i);
  });

  it("detects mixed binary and percent-encoded secret bytes", () => {
    const secret = Buffer.from([0xff, 0x00, 0x41, 0x2b]);
    expect(() => assertNoCredentialReflection(
      [secret], surfaces("frames", Buffer.from("%Ff%00A%2B")),
    )).toThrow(/reflection/i);
  });

  it("refuses aggregate provider-visible bytes above the reflection budget", () => {
    const items = Array.from({ length: 2_049 }, () => "z".repeat(4_096));
    expect(() => assertNoCredentialReflection(
      [Buffer.from("q")], surfaceList("status", items),
    )).toThrow(/reflection/i);
  });

  it("refuses secret-by-surface work above the reflection budget", () => {
    const secrets = Array.from({ length: 128 }, () => Buffer.from("q"));
    const items = Array.from({ length: 129 }, () => "z".repeat(4_096));
    expect(() => assertNoCredentialReflection(
      secrets, surfaceList("status", items),
    )).toThrow(/reflection/i);
  });

  it("persists descriptor-only state and strictly replaces it under mode 0600", async () => {
    const fixture = await trackedFixture();
    const registry = createCredentialRegistry([environmentHandle()]);
    await writeOperatorCredentialRegistry(fixture.paths, registry);
    await expect(readCredentialRegistryState(fixture.paths)).resolves.toEqual({ kind: "ok", registry });
    const file = path.join(fixture.paths.configRoot, "provider-credentials-v1.json");
    if (process.platform !== "win32") expect((await lstat(file)).mode & 0o777).toBe(0o600);
    await writeOperatorCredentialRegistry(fixture.paths, registry);
    expect(await lstat(file)).toBeDefined();
  });

  it("distinguishes absent, unreadable, invalid, and fatal UTF-8 credential state", async () => {
    const fixture = await trackedFixture();
    const file = path.join(fixture.paths.configRoot, "provider-credentials-v1.json");
    await expect(readCredentialRegistryState(fixture.paths)).resolves.toEqual({ kind: "absent" });
    await writeFile(file, Buffer.concat([Buffer.from('{"schemaVersion":1,"handles":{"credential-one":{"schemaVersion":1,"handleId":"credential-one","slotId":"api-token","source":{"kind":"os-keychain","service":"'), Buffer.from([0xff]), Buffer.from('","account":"a"},"allowedBrokerIds":["https-broker"]}}}')]));
    await expect(readCredentialRegistryState(fixture.paths)).resolves.toEqual({ kind: "invalid" });
    await rm(file); await symlink(path.join(fixture.root, "missing"), file);
    await expect(readCredentialRegistryState(fixture.paths)).resolves.toEqual({ kind: "unreadable" });
  });
});

function environmentHandle(): CredentialHandleV1 {
  return {
    schemaVersion: 1, handleId: "credential-one", slotId: "api-token",
    source: { kind: "environment", variable: SECRET_VARIABLE },
    allowedBrokerIds: [BROKER],
  };
}

async function trackedFixture(): Promise<ResolutionFixture> {
  const fixture = await installResolutionFixture(); fixtures.push(fixture); return fixture;
}

function surfaceCases() {
  const variants = secretEncodingCases();
  const names = ["urls", "headers", "errors", "status", "frames", "stdout", "stderr", "receipts", "retainedEvidence"] as const;
  return names.flatMap((surface) => variants.map(({ label, value }) => ({
    name: `${surface} ${label}`, surface, value,
  })));
}

function secretEncodingCases() {
  const bytes = Buffer.from(SECRET);
  const base64 = bytes.toString("base64");
  const percent = encodeURIComponent(SECRET);
  return [
    { label: "raw", value: SECRET }, { label: "base64", value: base64 },
    { label: "base64-unpadded", value: base64.replace(/=+$/, "") },
    { label: "base64url", value: bytes.toString("base64url") },
    { label: "hex-lower", value: bytes.toString("hex") },
    { label: "hex-upper", value: bytes.toString("hex").toUpperCase() },
    { label: "percent-upper", value: percent },
    { label: "percent-lower", value: percent.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()) },
  ];
}

function surfaces(
  key: keyof ProviderVisibleCredentialSurfacesV1,
  value: string | Buffer,
): ProviderVisibleCredentialSurfacesV1 {
  return surfaceList(key, [value]);
}

function surfaceList(
  key: keyof ProviderVisibleCredentialSurfacesV1,
  values: readonly (string | Buffer)[],
): ProviderVisibleCredentialSurfacesV1 {
  const empty = { urls: [], headers: [], errors: [], status: [], frames: [], stdout: [], stderr: [], receipts: [], retainedEvidence: [] };
  return { ...empty, [key]: values } as ProviderVisibleCredentialSurfacesV1;
}
