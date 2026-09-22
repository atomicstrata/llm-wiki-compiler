/**
 * @file test/capability-providers/untrusted-text.test.ts
 * @description The ONE home for provider bytes echoed into host lines: every unsafe
 * code point class collapses, the result is byte-bounded without a torn code point,
 * and a bare token is visibly delimited. Sites are witnessed where they compose
 * (custodian, admission, the paper-compile error frame); this pins the helper itself.
 */

import { describe, expect, it } from "vitest";
import { neutralisedProviderText, quotedProviderToken } from "../../src/capability-providers/runtime/untrusted-text.js";

describe("untrusted provider text", () => {
  it("collapses C0/C1 controls, format characters, and line separators to single spaces", () => {
    // newline, CRLF, ESC (C0), C1 CSI, bidi override (Cf), zero-width space (Cf), line separator (Zl)
    const out = neutralisedProviderText("a\nb\r\nc\x1b[31mde\u202ef\u200bg\u2028h", 512);
    expect(out).toBe("a b c [31md e f g h");
    expect(out).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  });

  it("bounds in UTF-8 bytes and never leaves a torn code point", () => {
    const out = neutralisedProviderText("編".repeat(100), 64);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(64);
    expect(out).toBe("編".repeat(21)); // 21 × 3 bytes = 63; the 22nd would be torn
    expect(out).not.toContain("�");
  });

  it("returns an empty string for whitespace-only input and trims the rest", () => {
    expect(neutralisedProviderText(" \t\n ", 64)).toBe("");
    expect(neutralisedProviderText("  x  ", 64)).toBe("x");
  });

  it("keeps the quoted region's boundary exact: guillemets inside the token cannot close or reopen it", () => {
    const quoted = quotedProviderToken("x» HOST: accepted «y");
    expect(quoted.indexOf("«")).toBe(0);
    expect(quoted.lastIndexOf("«")).toBe(0);
    expect(quoted.indexOf("»")).toBe(quoted.length - 1);
    expect(quoted).toContain("HOST: accepted"); // still readable, still inside the region
  });

  it("quotes a bare token between « and » after neutralising and bounding it to 128 bytes", () => {
    const quoted = quotedProviderToken(`id\n${"z".repeat(200)}`);
    expect(quoted.startsWith("«id z")).toBe(true);
    expect(quoted.endsWith("»")).toBe(true);
    expect(Buffer.byteLength(quoted.slice(1, -1), "utf8")).toBeLessThanOrEqual(128);
  });
});
