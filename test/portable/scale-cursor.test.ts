/**
 * @file test/portable/scale-cursor.test.ts
 * @description Unit witnesses for the paged cursor: it resolves only under the
 * exact tenant, project, predicate and fence it was issued for, and only when
 * keyed by the issuing host.
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { decodeCursor, encodeCursor, type CursorBinding } from "../../src/portable/scale/cursor.js";

const secret = randomBytes(32);
const binding: CursorBinding = { tenant: "t", project: "p", predicate: "pages:wiki/concepts/", fence: "root-3" };
const AFTER = "wiki/concepts/page-000050.md";

describe("paged cursor binding", () => {
  it("resumes after its position under the binding it was issued for", () => {
    expect(decodeCursor(secret, binding, encodeCursor(secret, binding, AFTER))).toBe(AFTER);
  });

  it("does not resolve when any part of the binding differs", () => {
    const cursor = encodeCursor(secret, binding, AFTER);
    const changes: Partial<CursorBinding>[] = [
      { tenant: "other" }, { project: "other" }, { predicate: "pages:sources/" }, { fence: "root-4" },
    ];
    for (const change of changes) expect(decodeCursor(secret, { ...binding, ...change }, cursor)).toBeNull();
  });

  it("does not resolve under another host's secret, when altered, or when malformed", () => {
    const cursor = encodeCursor(secret, binding, AFTER);
    const [payload, tag] = cursor.split(".");
    const forged = Buffer.from(JSON.stringify(["t", "p", binding.predicate, binding.fence, "wiki/concepts/a.md"])).toString("base64url");
    expect(decodeCursor(randomBytes(32), binding, cursor)).toBeNull();
    expect(decodeCursor(secret, binding, `${forged}.${tag}`)).toBeNull();
    expect(decodeCursor(secret, binding, payload)).toBeNull();
    expect(decodeCursor(secret, binding, `${cursor}.extra`)).toBeNull();
    expect(decodeCursor(secret, binding, "")).toBeNull();
  });
});
