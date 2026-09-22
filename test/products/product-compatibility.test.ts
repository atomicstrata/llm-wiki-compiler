/**
 * @file test/products/product-compatibility.test.ts
 * @description The pure structural compatibility assessor (design section 8.3 step
 * 3, structural floor). Fully-compatible facts pass; an unsupported schema, an
 * unrecognized contract pin, an unloadable knowledge profile, or an invalid
 * composition each fail closed with a named refusal. Operational readiness is out
 * of scope and never contributes a refusal — a compatible verdict is reached
 * without asserting anything about providers, credentials, or grants.
 */

import { describe, expect, it } from "vitest";
import {
  assessStructuralCompatibility, HOST_DECLARED_CONTRACT_SET, type StructuralCompatibilityInputsV1,
} from "../../src/products/compatibility.js";
import type { Sha256Digest } from "../../src/products/ids.js";

const FORGED_DIGEST = `sha256:${"a".repeat(64)}` as Sha256Digest;

const COMPATIBLE: StructuralCompatibilityInputsV1 = {
  packSchemaVersion: 2, knowledgeProfileSchemaVersion: 1,
  requiredKnowledgeProfileSchemaVersion: 1, requiredOperationsPackSchemaVersion: 2,
  requiredProviderContractDigest: HOST_DECLARED_CONTRACT_SET.providerContractDigest,
  requiredOrchestrationContractDigest: HOST_DECLARED_CONTRACT_SET.orchestrationContractDigest,
  requiredMilestoneAContractDigest: HOST_DECLARED_CONTRACT_SET.milestoneAContractDigest,
  requiredHostHandlerRegistryVersion: HOST_DECLARED_CONTRACT_SET.hostHandlerRegistryVersion,
  requiredHostHandlerRegistryDigest: HOST_DECLARED_CONTRACT_SET.hostHandlerRegistryDigest,
  knowledgeProfileLoadable: true, compositionValid: true,
};

describe("assessStructuralCompatibility", () => {
  it("passes fully-compatible structural facts with no refusals", () => {
    const report = assessStructuralCompatibility(COMPATIBLE);
    expect(report.structurallyCompatible).toBe(true);
    expect(report.refusals).toEqual([]);
  });

  it("refuses an unsupported pack schema version", () => {
    const report = assessStructuralCompatibility({ ...COMPATIBLE, packSchemaVersion: 3 });
    expect(report.schemaSupported).toBe(false);
    expect(report.structurallyCompatible).toBe(false);
  });

  it("refuses an unrecognized required contract-schema pin", () => {
    const report = assessStructuralCompatibility({ ...COMPATIBLE, requiredOperationsPackSchemaVersion: 1 });
    expect(report.contractPinsRecognized).toBe(false);
    expect(report.structurallyCompatible).toBe(false);
  });

  // Pin EVERY declared contract-digest field so neutralizing any single AND-chain
  // leg reddens a test — the host must reject a pack that forges any one of them.
  it.each([
    "requiredProviderContractDigest",
    "requiredOrchestrationContractDigest",
    "requiredMilestoneAContractDigest",
    "requiredHostHandlerRegistryDigest",
  ] as const)("refuses a forged %s the host does not declare", (field) => {
    const report = assessStructuralCompatibility({ ...COMPATIBLE, [field]: FORGED_DIGEST });
    expect(report.contractPinsRecognized).toBe(false);
    expect(report.structurallyCompatible).toBe(false);
  });

  it("refuses a required host-handler-registry version the host does not declare", () => {
    const report = assessStructuralCompatibility({ ...COMPATIBLE, requiredHostHandlerRegistryVersion: "9.9.9" });
    expect(report.contractPinsRecognized).toBe(false);
    expect(report.structurallyCompatible).toBe(false);
  });

  it("refuses an unloadable knowledge profile", () => {
    const report = assessStructuralCompatibility({ ...COMPATIBLE, knowledgeProfileLoadable: false });
    expect(report.structurallyCompatible).toBe(false);
    expect(report.refusals).toContain("active knowledge profile is not loadable");
  });

  it("refuses an invalid composition", () => {
    const report = assessStructuralCompatibility({ ...COMPATIBLE, compositionValid: false });
    expect(report.compositionValid).toBe(false);
    expect(report.structurallyCompatible).toBe(false);
  });
});
