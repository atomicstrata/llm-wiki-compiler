/**
 * @file test/profile-template-lock-read.test.ts
 * @description Exercises strict v1/v2 advisory-lock parsing and confined reads.
 */
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_TEMPLATE_LOCK_BYTES,
  parseTemplateLock,
  readTemplateLock,
  TEMPLATE_LOCK_FILE,
} from "../src/profile/templates/lock.js";
import { makeTempRoot } from "./fixtures/temp-root.js";

const BASE = {
  templateId: "team",
  version: "1.2.3",
  publisher: "example",
  sourceType: "local",
  installedAt: "2026-07-12T00:00:00.000Z",
  profileDigest: "a".repeat(64),
};

describe("parseTemplateLock", () => {
  it("accepts legacy v1 and current v2 locks", () => {
    expect(parseTemplateLock({ schemaVersion: 1, ...BASE })).toMatchObject({ kind: "ok", lock: { schemaVersion: 1 } });
    expect(parseTemplateLock({ schemaVersion: 2, ...BASE })).toMatchObject({ kind: "ok", lock: { schemaVersion: 2 } });
  });

  it("accepts complete remote v2 provenance", () => {
    const remote = {
      coordinate: "official/example/team@1.2.3",
      packageDigest: `sha256:${"b".repeat(64)}`,
      tap: "official",
      indexSequence: 4,
      publisherKeyId: "ed25519:example",
      verifiedAt: "2026-07-12T00:00:00.000Z",
    };
    const result = parseTemplateLock({ schemaVersion: 2, ...BASE, sourceType: "remote", remote });
    expect(result).toMatchObject({ kind: "ok", lock: { sourceType: "remote", remote } });
  });

  it("rejects authority-looking extras and incomplete remote provenance", () => {
    expect(parseTemplateLock({ schemaVersion: 2, ...BASE, trusted: true })).toMatchObject({ kind: "malformed" });
    expect(parseTemplateLock({ schemaVersion: 2, ...BASE, sourceType: "remote" })).toMatchObject({ kind: "malformed" });
    expect(parseTemplateLock({ schemaVersion: 2, ...BASE, remote: {} })).toMatchObject({ kind: "malformed" });
  });
});

describe("readTemplateLock", () => {
  it("distinguishes absent, malformed, and valid locks", async () => {
    const root = await makeTempRoot("template-lock-read");
    expect(await readTemplateLock(root)).toEqual({ kind: "absent" });
    await mkdir(path.join(root, ".llmwiki"), { recursive: true });
    await writeFile(path.join(root, TEMPLATE_LOCK_FILE), "{broken", "utf8");
    expect(await readTemplateLock(root)).toMatchObject({ kind: "malformed" });
    await writeFile(path.join(root, TEMPLATE_LOCK_FILE), JSON.stringify({ schemaVersion: 2, ...BASE }), "utf8");
    expect(await readTemplateLock(root)).toMatchObject({ kind: "ok", lock: { templateId: "team" } });
  });

  it("fails closed on symlinked and oversized lock leaves", async () => {
    const root = await makeTempRoot("template-lock-unsafe");
    const outside = await makeTempRoot("template-lock-outside");
    await mkdir(path.join(root, ".llmwiki"), { recursive: true });
    const leaf = path.join(root, TEMPLATE_LOCK_FILE);
    await writeFile(path.join(outside, "lock.json"), JSON.stringify({ schemaVersion: 2, ...BASE }), "utf8");
    await symlink(path.join(outside, "lock.json"), leaf);
    expect(await readTemplateLock(root)).toMatchObject({ kind: "unavailable" });
  });

  it("refuses an oversized regular lock without parsing it", async () => {
    const root = await makeTempRoot("template-lock-oversize");
    await mkdir(path.join(root, ".llmwiki"), { recursive: true });
    await writeFile(path.join(root, TEMPLATE_LOCK_FILE), "x".repeat(MAX_TEMPLATE_LOCK_BYTES + 1), "utf8");
    expect(await readTemplateLock(root)).toMatchObject({ kind: "unavailable" });
  });
});
