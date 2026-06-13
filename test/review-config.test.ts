/**
 * Tests for the fail-closed review config loader.
 *
 * Missing config is the legitimate "policy off" path. A present but corrupt
 * or invalid `.llmwiki/config.json` must abort instead of silently disabling
 * review policy.
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { loadReviewPolicy, normalizeReviewPolicy, ReviewConfigError } from "../src/review/config.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

async function writeConfig(value: unknown): Promise<void> {
  await mkdir(path.join(root.dir, ".llmwiki"), { recursive: true });
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  await writeFile(path.join(root.dir, ".llmwiki", "config.json"), body, "utf-8");
}

describe("loadReviewPolicy", () => {
  it("treats missing config as policy off", async () => {
    const policy = await loadReviewPolicy(root.dir);
    expect(policy.hold).toEqual([]);
    expect(policy.lowConfidenceThreshold).toBe(0.5);
    expect(policy.treatMissingConfidenceAs).toBe("low");
  });

  it("loads a valid policy config", async () => {
    await writeConfig({
      version: 1,
      review: {
        hold: ["low-confidence", "contradicted"],
        lowConfidenceThreshold: 0.7,
        treatMissingConfidenceAs: "ok",
      },
    });
    await expect(loadReviewPolicy(root.dir)).resolves.toMatchObject({
      hold: ["low-confidence", "contradicted"],
      lowConfidenceThreshold: 0.7,
      treatMissingConfidenceAs: "ok",
    });
  });

  it("throws on corrupt JSON", async () => {
    await writeConfig("{ broken");
    await expect(loadReviewPolicy(root.dir)).rejects.toBeInstanceOf(ReviewConfigError);
  });
});

describe("normalizeReviewPolicy", () => {
  it("accepts absent review, empty hold, and explicit off as off", () => {
    expect(normalizeReviewPolicy({ version: 1 }).hold).toEqual([]);
    expect(normalizeReviewPolicy({ version: 1, review: { hold: [] } }).hold).toEqual([]);
    expect(normalizeReviewPolicy({ version: 1, review: { hold: ["off"] } }).hold).toEqual([]);
  });

  it("rejects unknown modes and bad all/off combinations", () => {
    expect(() => normalizeReviewPolicy({ version: 1, review: { hold: ["low_confidence"] } })).toThrow(ReviewConfigError);
    expect(() => normalizeReviewPolicy({ version: 1, review: { hold: ["off", "contradicted"] } })).toThrow(ReviewConfigError);
    expect(() => normalizeReviewPolicy({ version: 1, review: { hold: ["all", "contradicted"] } })).toThrow(ReviewConfigError);
  });

  it("validates threshold and missing-confidence policy", () => {
    expect(() => normalizeReviewPolicy({ version: 1, review: { hold: ["low-confidence"], lowConfidenceThreshold: -0.1 } })).toThrow(ReviewConfigError);
    expect(() => normalizeReviewPolicy({ version: 1, review: { hold: ["low-confidence"], lowConfidenceThreshold: Number.NaN } })).toThrow(ReviewConfigError);
    expect(() => normalizeReviewPolicy({ version: 1, review: { hold: ["low-confidence"], treatMissingConfidenceAs: "maybe" } })).toThrow(ReviewConfigError);
  });

  it("accepts inert threshold and rejects unsupported version", () => {
    expect(normalizeReviewPolicy({ version: 1, review: { hold: ["contradicted"], lowConfidenceThreshold: 0.2 } }).lowConfidenceThreshold).toBe(0.2);
    expect(() => normalizeReviewPolicy({ version: 2, review: { hold: [] } })).toThrow(ReviewConfigError);
  });

  it("missing version is a hard error", () => {
    expect(() => normalizeReviewPolicy({ review: { hold: [] } })).toThrow(ReviewConfigError);
    expect(() => normalizeReviewPolicy({ review: { hold: [] } })).toThrow('"version": 1');
  });
});

