/**
 * @file test/capability-providers/https-broker.test.ts
 * @description HTTPS broker substrate regressions for typed methods, captured
 * bodies, exact-origin redirects, and request/response byte ceilings.
 */
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  confinedFetchRequest, type ConfinedHttpRequest,
} from "../../src/connectors/confined-fetch.js";

const LIMITS = Object.freeze({
  timeoutMs: 1_000, maxBytes: 64, maxTransportBytes: 64,
  maxRedirects: 2, contentTypes: ["application/json"], maxRequestBytes: 16,
});
const POLICY = Object.freeze({
  allowedHosts: ["api.example"], allowedOrigins: ["https://api.example"],
});

describe("HTTPS broker confined request seam", () => {
  it("passes an exact typed method and captured body to the pinned request", async () => {
    const seen: ConfinedHttpRequest[] = [];
    const body = Buffer.from('{"ok":true}');
    const result = await confinedFetchRequest({
      url: "https://api.example/v1/items", method: "POST", headers: {}, body,
    }, LIMITS, POLICY, seams(seen));
    body.fill(0);
    expect(result.kind).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/v1/items" });
    expect(seen[0]?.body?.toString()).toBe('{"ok":true}');
  });

  it("refuses mutating redirect downgrades without sending a second request", async () => {
    const request = vi.fn(async () => ({
      statusCode: 303, headers: { location: "/logged-in" }, body: Readable.from([]),
    }));
    const result = await confinedFetchRequest({
      url: "https://api.example/session", method: "POST", headers: {}, body: Buffer.from("x"),
    }, LIMITS, POLICY, { lookup: publicLookup, request });
    expect(result).toEqual({ kind: "refused", reason: "connector redirect cannot change request semantics" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("refuses cross-origin redirects and request bodies over the cap before dialing", async () => {
    const request = vi.fn(async () => ({
      statusCode: 307, headers: { location: "https://other.example/path" }, body: Readable.from([]),
    }));
    const redirected = await confinedFetchRequest({
      url: "https://api.example/path", method: "POST", headers: {}, body: Buffer.from("x"),
    }, LIMITS, POLICY, { lookup: publicLookup, request });
    const oversized = await confinedFetchRequest({
      url: "https://api.example/path", method: "POST", headers: {}, body: Buffer.alloc(17),
    }, LIMITS, POLICY, { lookup: publicLookup, request });
    expect(redirected).toMatchObject({ kind: "refused", reason: expect.stringMatching(/origin|host/) });
    expect(oversized).toEqual({ kind: "refused", reason: "connector request exceeds byte cap" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds response headers before reading provider-visible body bytes", async () => {
    const body = Readable.from(["{}"]);
    const result = await confinedFetchRequest({
      url: "https://api.example/path", method: "GET", headers: {},
    }, { ...LIMITS, maxResponseHeaderBytes: 16 }, POLICY, {
      lookup: publicLookup,
      request: async () => ({
        statusCode: 200, headers: { "content-type": "application/json", "x-long": "x".repeat(20) }, body,
      }),
    });
    expect(result).toEqual({ kind: "refused", reason: "connector response headers exceed byte cap" });
    expect(body.destroyed).toBe(true);
  });
});

function seams(seen: ConfinedHttpRequest[]) {
  return {
    lookup: publicLookup,
    request: async (request: ConfinedHttpRequest) => {
      seen.push(request);
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: Readable.from(["{}"]), };
    },
  };
}

async function publicLookup() {
  return [{ address: "93.184.216.34", family: 4 as const }];
}
