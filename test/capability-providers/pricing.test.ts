/**
 * @file test/capability-providers/pricing.test.ts
 * @description Host-owned, digest-pinned provider pricing and fail-closed
 * unknown-price behavior for Provider V2 Task 5.
 */
import path from "node:path";
import { rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  hostPriceTableDigest, parseHostPriceTable, readHostPriceTable, resolveHostPrice,
  writeOperatorPriceTable,
} from "../../src/capability-providers/authority/pricing.js";
import { installResolutionFixture, removeResolutionFixture, type ResolutionFixture } from "./resolution-fixture.js";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";

const fixtures: ResolutionFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map(removeResolutionFixture)));

describe("host-owned provider pricing", () => {
  it("resolves one exact active service/model key from actual host state", async () => {
    const { fixture, digest } = await trackedPriceTable();
    await expect(resolveHostPrice(fixture.paths, priceRequest(), digest, new Date("2026-07-18T12:00:00Z"))).resolves
      .toMatchObject({ unit: "token", priceUsdPerUnit: 0.00001, priceTableDigest: digest });
  });

  it("snapshots the price request before host-state I/O", async () => {
    const { fixture, digest } = await trackedPriceTable();
    const request = priceRequest();
    const resolution = resolveHostPrice(
      fixture.paths, request, digest, new Date("2026-07-18T12:00:00Z"),
    );
    request.modelOrSku = "mutated-sku";
    await expect(resolution).resolves.toMatchObject({ modelOrSku: "gpt-test" });
  });

  it("snapshots the pricing clock before host-state I/O", async () => {
    const { fixture, digest } = await trackedPriceTable();
    const now = new Date("2026-07-18T12:00:00Z");
    const resolution = resolveHostPrice(fixture.paths, priceRequest(), digest, now);
    now.setUTCFullYear(2027);
    await expect(resolution).resolves.toMatchObject({ modelOrSku: "gpt-test" });
  });

  it("captures the pricing clock through the intrinsic Date value", async () => {
    const { fixture, digest } = await trackedPriceTable();
    class AdversarialDate extends Date {
      override getTime(): number { throw new Error("caller-owned override"); }
    }
    const now = new AdversarialDate("2026-07-18T12:00:00Z");
    await expect(resolveHostPrice(fixture.paths, priceRequest(), digest, now)).resolves
      .toMatchObject({ modelOrSku: "gpt-test" });
  });

  it("rejects invalid and proxied pricing clocks with a stable error", async () => {
    const { fixture, digest } = await trackedPriceTable();
    await expect(resolveHostPrice(fixture.paths, priceRequest(), digest, new Date(Number.NaN)))
      .rejects.toThrow(/pricing.*unavailable/i);
    const proxied = new Proxy(new Date("2026-07-18T12:00:00Z"), {});
    await expect(resolveHostPrice(fixture.paths, priceRequest(), digest, proxied))
      .rejects.toThrow(/pricing.*unavailable/i);
  });

  it("refuses unknown, drifted, expired, and provider-declared prices instead of using zero", async () => {
    const { fixture, digest } = await trackedPriceTable();
    await expect(resolveHostPrice(fixture.paths, { ...priceRequest(), modelOrSku: "unknown" }, digest,
      new Date("2026-07-18T12:00:00Z"))).rejects.toThrow(/pricing.*unavailable/i);
    await expect(resolveHostPrice(fixture.paths, priceRequest(), parseSha256Digest(`sha256:${"f".repeat(64)}`),
      new Date("2026-07-18T12:00:00Z"))).rejects.toThrow(/pricing.*drift/i);
    await expect(resolveHostPrice(fixture.paths, priceRequest(), digest,
      new Date("2027-07-18T12:00:00Z"))).rejects.toThrow(/pricing.*unavailable/i);
    await expect(resolveHostPrice(fixture.paths, { ...priceRequest(), declaredPriceUsd: 0 } as never,
      digest, new Date("2026-07-18T12:00:00Z"))).rejects.toThrow(/pricing.*invalid/i);
  });

  it("rejects duplicate or ambiguous exact price intervals", () => {
    const table = priceTable();
    table.entries.push({ ...table.entries[0] });
    expect(() => parseHostPriceTable(JSON.stringify(table))).toThrow(/duplicate|ambiguous/i);
  });

  it("persists only a digest-confirmed host table through the operator transaction", async () => {
    const fixture = await installResolutionFixture();
    fixtures.push(fixture);
    const table = parseHostPriceTable(JSON.stringify(priceTable()));
    const digest = hostPriceTableDigest(table);
    await writeOperatorPriceTable(fixture.paths, table, digest);
    await expect(readHostPriceTable(fixture.paths)).resolves.toEqual(table);
    await expect(writeOperatorPriceTable(fixture.paths, table, fixture.pin.packageDigest))
      .rejects.toThrow(/confirmation/i);
  });

  it("uses the versioned host-shipped table only when operator pricing is absent", async () => {
    const fixture = await trackedFixture();
    const table = await readHostPriceTable(fixture.paths);
    expect(table).toMatchObject({ schemaVersion: 1, currency: "USD", entries: [] });
  });

  it("rejects subnormal and unsafe near-zero prices", () => {
    for (const priceUsdPerUnit of [Number.MIN_VALUE, 1e-13]) {
      const table = priceTable();
      table.entries[0].priceUsdPerUnit = priceUsdPerUnit;
      expect(() => parseHostPriceTable(JSON.stringify(table))).toThrow(/pricing.*invalid/i);
    }
  });

  it("never falls back over unreadable, invalid, or non-UTF-8 operator state", async () => {
    const fixture = await trackedFixture();
    const file = path.join(fixture.paths.configRoot, "provider-pricing-v1.json");
    await writeFile(file, "{\"schemaVersion\":1}\n");
    await expect(readHostPriceTable(fixture.paths)).rejects.toThrow(/pricing.*unavailable/i);
    await writeFile(file, Buffer.concat([Buffer.from('{"schemaVersion":1,"currency":"USD","validFrom":"2026-07-01T00:00:00.000Z","validUntil":"2026-08-01T00:00:00.000Z","entries":[{"brokerContract":"model-broker-v1","service":"'), Buffer.from([0xff]), Buffer.from('","modelOrSku":"gpt-test","unit":"token","priceUsdPerUnit":0.001}]}')]));
    await expect(readHostPriceTable(fixture.paths)).rejects.toThrow(/pricing.*unavailable/i);
    await rm(file); await symlink(path.join(fixture.root, "missing"), file);
    await expect(readHostPriceTable(fixture.paths)).rejects.toThrow(/pricing.*unavailable/i);
  });
});

async function trackedFixture(): Promise<ResolutionFixture> {
  const fixture = await installResolutionFixture(); fixtures.push(fixture); return fixture;
}

async function trackedPriceTable() {
  const fixture = await trackedFixture();
  const table = parseHostPriceTable(JSON.stringify(priceTable()));
  const digest = hostPriceTableDigest(table);
  await writeOperatorPriceTable(fixture.paths, table, digest);
  return { fixture, table, digest };
}

function priceTable() {
  return {
    schemaVersion: 1, currency: "USD", validFrom: "2026-07-01T00:00:00.000Z",
    validUntil: "2026-08-01T00:00:00.000Z", entries: [{
      brokerContract: "model-broker-v1", service: "openai", modelOrSku: "gpt-test",
      unit: "token", priceUsdPerUnit: 0.00001,
    }],
  };
}

function priceRequest() {
  return {
    brokerContract: "model-broker-v1", service: "openai", modelOrSku: "gpt-test",
    unit: "token", currency: "USD" as const,
  };
}
