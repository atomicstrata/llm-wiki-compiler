/**
 * @file test/profile-template-signing-fixture.test.ts
 * @description Cross-repository offline vector proving checked-in package and
 * index bytes parse, verify, and validate without private keys or network I/O.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSignedPackage, parseSignedTapIndex } from "../src/profile/templates/signing/protocol.js";
import { advancePublisherPins, emptyPublisherPinState } from "../src/profile/templates/signing/continuity.js";
import type { PublisherKey } from "../src/profile/templates/signing/types.js";
import { verifySignedPackage, verifyTapIndex } from "../src/profile/templates/signing/verify.js";

const FIXTURES = path.resolve("test/fixtures/template-registry");

describe("template registry protocol fixture", () => {
  it("verifies checked-in marketplace-compatible bytes offline", async () => {
    const packageText = await readFile(path.join(FIXTURES, "package.json"), "utf8");
    const indexText = await readFile(path.join(FIXTURES, "index.json"), "utf8");
    const trust = JSON.parse(await readFile(path.join(FIXTURES, "trust.json"), "utf8")) as { tap: PublisherKey };
    const index = verifyTapIndex(
      parseSignedTapIndex(indexText), "official", trust.tap, new Date("2026-07-13T00:00:00Z"),
    );
    const state = advancePublisherPins(index, emptyPublisherPinState("official"));
    const pkg = verifySignedPackage(parseSignedPackage(packageText), index, state, "1.0.0");
    expect(pkg).toMatchObject({ templateId: "team", publisher: "atomicstrata", sourceType: "remote" });
  });
});
