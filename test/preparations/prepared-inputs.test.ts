/**
 * @file test/preparations/prepared-inputs.test.ts
 * @description Happy-path prepared-input contract: caller files are planned as
 * host-minted immutable descriptors, materialized into the create-only evidence
 * CAS, and read back exactly; structured values are canonicalized into evidence;
 * and the host-minted input ID is a stable slug bound to source identity + digest.
 */

import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { readPreparationEvidence } from "../../src/preparations/evidence-store.js";
import { mintPreparationId } from "../../src/preparations/ids.js";
import {
  materializeCallerFileInput, mintPreparedInputId, planCallerFileInput,
  prepareStructuredValueInput,
} from "../../src/preparations/inputs.js";
import type {
  CallerFileIdentityV1, MaterializeCallerFileOutcomeV1, PlanCallerFileOutcomeV1,
  PreparedCallerFileV1, PreparedInputMetadataV1, StructuredValueSourceV1,
} from "../../src/preparations/inputs.js";
import { bareDigest, callerSource, writeSourceFile } from "./inputs-fixture.js";

const root = useTempRoot();
const location = () => ({ workspaceId: "research", preparationId: mintPreparationId() });

describe("planCallerFileInput", () => {
  it("mints an immutable descriptor bound to the source identity and digest", async () => {
    const bytes = Buffer.from("prepared-input-bytes");
    const leaf = await writeSourceFile(`${root.dir}/sources`, "input.txt", bytes);
    const planned: PlanCallerFileOutcomeV1 = await planCallerFileInput(callerSource(`${root.dir}/sources`, leaf));
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") return;
    const prepared: PreparedCallerFileV1 = planned.prepared;
    const identity: CallerFileIdentityV1 = prepared.identity;
    expect(identity.size).toBe(bytes.byteLength);
    expect(prepared.input.digest).toBe(`sha256:${bareDigest(bytes)}`);
    expect(prepared.input.byteCount).toBe(bytes.byteLength);
    expect(prepared.input.inputId).toBe(mintPreparedInputId("sources/input.txt", bareDigest(bytes)));
    expect(prepared.input.evidenceRef.untrusted).toBe(true);
  });

  it("materializes the immutable copy into the create-only evidence CAS", async () => {
    const bytes = Buffer.from("materialize-me");
    const leaf = await writeSourceFile(`${root.dir}/sources`, "m.txt", bytes);
    const planned = await planCallerFileInput(callerSource(`${root.dir}/sources`, leaf));
    if (planned.status !== "planned") throw new Error("not planned");
    const loc = location();
    const done: MaterializeCallerFileOutcomeV1 = await materializeCallerFileInput(root.dir, loc, planned.prepared);
    expect(done.status).toBe("materialized");
    const read = await readPreparationEvidence(root.dir, loc, bareDigest(bytes));
    expect(read.status === "ok" && read.byteCount).toBe(bytes.byteLength);
  });
});

describe("prepareStructuredValueInput", () => {
  it("canonicalizes a structured value into a stable evidence descriptor", async () => {
    const meta: PreparedInputMetadataV1 = {
      sourceIdentity: "struct/config", provenanceLabel: "structured", mediaType: "application/json",
      sensitivity: "ordinary", retention: "until-handoff", evidenceKind: "prepared-input",
    };
    const first = prepareStructuredValueInput({ ...meta, value: { b: 2, a: 1 } } as StructuredValueSourceV1);
    const second = prepareStructuredValueInput({ ...meta, value: { a: 1, b: 2 } } as StructuredValueSourceV1);
    expect(first.digest).toBe(second.digest);
    expect(bareDigest(first.bytes)).toBe(first.digest.slice("sha256:".length));
    expect(first.input.inputId).toBe(second.input.inputId);
  });
});

describe("mintPreparedInputId", () => {
  it("is a stable slug that changes when the content digest changes", () => {
    const a = mintPreparedInputId("sources/x", "a".repeat(64));
    expect(a).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(mintPreparedInputId("sources/x", "a".repeat(64))).toBe(a);
    expect(mintPreparedInputId("sources/x", "b".repeat(64))).not.toBe(a);
  });
});
