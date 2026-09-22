/**
 * @file test/capability-providers/provider-inputs.test.ts
 * @description Invocation-private input materialization. The host derives each
 * input's digest and byte count, writes read-only bytes into the inputs mount,
 * mints an opaque token, and returns the stable exposure digest computed from
 * the materialized inputs (D6.3). Oversize aggregates are refused.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { providerExposureDigest } from "../../src/capability-providers/authority/exposure.js";
import {
  materializeProviderInputs, type ProviderInputSpecV1,
} from "../../src/capability-providers/runtime/inputs.js";
import { MAX_MATERIALIZED_INPUT_FILE_BYTES } from "../../src/capability-providers/constants.js";
import { useScratchDirs } from "./scratch-dirs.js";

const scratch = useScratchDirs();

async function namespace(): Promise<string> {
  return scratch("llmwiki-inputs-");
}

function spec(inputId: string, text: string): ProviderInputSpecV1 {
  return { inputId, kind: "source", provenanceLabel: `label-${inputId}`, mediaType: "text/plain", bytes: Buffer.from(text) };
}

describe("provider input materialization", () => {
  it("derives digest, byte count, token, and the stable exposure digest", async () => {
    const dir = await namespace();
    const materialized = await materializeProviderInputs(dir, [spec("alpha", "hello"), spec("beta", "world!")]);
    expect(materialized.inputs).toHaveLength(2);
    const alpha = materialized.inputs[0];
    expect(alpha.byteCount).toBe(5);
    expect(alpha.digest).toBe(`sha256:${createHash("sha256").update("hello").digest("hex")}`);
    expect(alpha.materializedToken).toMatch(/^in-[0-9a-f]{32}$/);
    expect(materialized.exposureDigest).toBe(providerExposureDigest(materialized.inputs));
    await materialized.dispose();
  });

  it("writes read-only input bytes into the inputs mount", async () => {
    const dir = await namespace();
    const materialized = await materializeProviderInputs(dir, [spec("alpha", "payload-bytes")]);
    const token = materialized.inputs[0].materializedToken;
    expect(await readFile(path.join(dir, materialized.sandboxMountRelative, token), "utf8")).toBe("payload-bytes");
    await materialized.dispose();
  });

  it("emits input token descriptors that match the exposure refs", async () => {
    const dir = await namespace();
    const materialized = await materializeProviderInputs(dir, [spec("alpha", "abc")]);
    expect(materialized.inputTokens[0]).toMatchObject({
      inputId: "alpha", token: materialized.inputs[0].materializedToken, byteCount: 3,
    });
    await materialized.dispose();
  });

  it("refuses an input over the per-file byte ceiling", async () => {
    const dir = await namespace();
    const oversize: ProviderInputSpecV1 = { ...spec("alpha", ""), bytes: fakeOversizeBytes() };
    await expect(materializeProviderInputs(dir, [oversize])).rejects.toThrow(/ceiling/);
  });
});

/** A byte view that reports an over-ceiling length without allocating gigabytes. */
function fakeOversizeBytes(): Uint8Array {
  const view = new Uint8Array(1);
  Object.defineProperty(view, "byteLength", { value: MAX_MATERIALIZED_INPUT_FILE_BYTES + 1 });
  return view;
}
