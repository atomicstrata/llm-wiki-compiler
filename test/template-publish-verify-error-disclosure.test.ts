/**
 * @file test/template-publish-verify-error-disclosure.test.ts
 * @description Regression coverage for bounded, path-free publisher verifier
 * failures at the public CLI boundary.
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPublishDistribution,
  diagnostics,
  removePublishDistribution,
  runPublishVerify,
  type PublishDistribution,
} from "./fixtures/template-publish-distribution.js";

const fixtures: PublishDistribution[] = [];
const MAX_PUBLIC_ERROR_CHARACTERS = 4_096;
const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const ANSI_COLOR = /\u001b\[[0-9;]*m/gu;

afterEach(async () => Promise.all(fixtures.splice(0).map(removePublishDistribution)));

describe("template publish verify error disclosure", () => {
  it.each([{ args: [] }, { args: ["--json"] }])("keeps $args missing-root failures bounded and path-free", async ({ args }) => {
    const tree = await createPublishDistribution();
    fixtures.push(tree);
    const secretPath = path.join(tree.root, `secret-\n\r\u001b-${"x".repeat(180)}`);
    tree.directory = secretPath;

    const result = runPublishVerify(tree, args);
    const output = diagnostics(result);

    expect(result.status).not.toBe(0);
    expect(output).toMatch(/distribution root.*unavailable|cannot be confined/i);
    expect(output).not.toContain(secretPath);
    expect(output.length).toBeLessThanOrEqual(MAX_PUBLIC_ERROR_CHARACTERS);
    expect(output.replace(ANSI_COLOR, "").trim()).not.toMatch(TERMINAL_CONTROL);
  });
});
