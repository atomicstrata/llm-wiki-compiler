/**
 * @file test/operations-packs/handler-registry.test.ts
 * @description The generic host-handler registry (design section 16.1) resolves
 * each of the six registered families to its exact descriptor with a stable
 * computed contract digest, and fails closed on an unknown handler id, a wrong
 * contract version, and a drifted contract digest — the drift the sealed attempt
 * revalidates against. The resolved handler is the pending-runtime shell that never
 * writes until a later WOP slice binds the sealed body and evidence.
 */

import { describe, expect, it } from "vitest";
import {
  createHostHandlerRegistry, hostHandlerRefFor, HOST_HANDLER_FAMILY_IDS,
} from "../../src/operations-packs/handlers/registry.js";
import { PackHostHandlerError } from "../../src/operations-packs/handlers/types.js";

const registry = createHostHandlerRegistry();

describe("host-handler registry", () => {
  it("resolves each of the six families to a deterministic read-only descriptor", () => {
    expect(HOST_HANDLER_FAMILY_IDS).toHaveLength(6);
    for (const id of HOST_HANDLER_FAMILY_IDS) {
      const { descriptor } = registry.resolve(hostHandlerRefFor(id));
      expect(descriptor.handlerId).toBe(id);
      expect(descriptor.deterministic).toBe(true);
      expect(descriptor.recovery).toBe("restart-safe");
      expect(["pure", "reads-project"]).toContain(descriptor.effectClass);
    }
  });

  it("computes a stable contract digest across registry instances", () => {
    const other = createHostHandlerRegistry();
    for (const id of HOST_HANDLER_FAMILY_IDS) {
      expect(registry.resolve(hostHandlerRefFor(id)).descriptor.handlerContractDigest)
        .toBe(other.resolve(hostHandlerRefFor(id)).descriptor.handlerContractDigest);
    }
  });

  it("refuses an unknown handler id", () => {
    expect(() => registry.resolve({ ...hostHandlerRefFor("set-select"), handlerId: "not-a-family" })).toThrow(PackHostHandlerError);
  });

  it("refuses a wrong contract version", () => {
    expect(() => registry.resolve({ ...hostHandlerRefFor("set-select"), handlerContractVersion: "2.0.0" })).toThrow(PackHostHandlerError);
  });

  it("refuses a drifted contract digest", () => {
    const drifted = hostHandlerRefFor("reconcile").handlerContractDigest;
    expect(() => registry.resolve({ ...hostHandlerRefFor("set-select"), handlerContractDigest: drifted })).toThrow(PackHostHandlerError);
  });

  it("resolves a pending-runtime handler that fails closed and never writes", async () => {
    const { handler } = registry.resolve(hostHandlerRefFor("render-template"));
    expect((await handler.execute(undefined as never)).kind).toBe("failed");
  });
});
