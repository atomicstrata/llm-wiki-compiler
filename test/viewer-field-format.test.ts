/**
 * @file test/viewer-field-format.test.ts
 * @description `formatHref` — the only place the viewer builds a URL out of
 * page content, and therefore the only place with a security contract.
 *
 * The FORMAT comes from the profile; the VALUE comes from a wiki page, i.e. from
 * whatever an author or a connector wrote. So the value is untrusted input and
 * every branch fails closed: a `url` must parse and carry an http(s) scheme, and
 * a `doi`/`arxiv` id must match its identifier grammar AND resolve to the fixed
 * resolver origin.
 *
 * The containment is the ORIGIN check, not the grammar. That distinction is
 * load-bearing: an earlier version tried to contain by forbidding `/`, `?` and
 * `#` in a DOI suffix, which does not make the link safer (the origin is a
 * literal) and silently dropped real DOIs like `10.5061/dryad.abc/1` to plain
 * text. The grammar now identifies; the origin check contains.
 *
 * Returning null means "render as text", which is the answer whenever the guard
 * is not certain — a value shown as text is merely unhelpful, while a value
 * linked wrongly is a live `javascript:` or an off-site redirect.
 *
 * The renderer guards independently of profile validation. Validation rejects an
 * unknown format at load, but this module must not trust that a validator ran
 * somewhere upstream: `/api/pages` is a wire boundary, and code on the far side
 * of one re-checks.
 */

import { describe, expect, it } from "vitest";
import { formatHref } from "../src/viewer/assets/viewer-field-format.js";

describe("formatHref resolves the declared vocabulary", () => {
  it("resolves a doi through the fixed doi.org origin", () => {
    expect(formatHref("doi", "10.1000/xyz123")).toBe("https://doi.org/10.1000/xyz123");
  });

  it("resolves a modern and a legacy arxiv id through the fixed arxiv origin", () => {
    expect(formatHref("arxiv", "1706.03762")).toBe("https://arxiv.org/abs/1706.03762");
    expect(formatHref("arxiv", "2401.01234v2")).toBe("https://arxiv.org/abs/2401.01234v2");
    expect(formatHref("arxiv", "math.GT/0309136")).toBe("https://arxiv.org/abs/math.GT/0309136");
  });

  it("passes an http(s) url through unchanged", () => {
    expect(formatHref("url", "https://example.org/a?b=c#d")).toBe("https://example.org/a?b=c#d");
    expect(formatHref("url", "http://example.org/a")).toBe("http://example.org/a");
  });

  it("trims surrounding whitespace before resolving", () => {
    expect(formatHref("doi", "  10.1000/xyz123  ")).toBe("https://doi.org/10.1000/xyz123");
  });
});

describe("formatHref refuses anything it is not certain about", () => {
  it("refuses a non-http scheme rather than linking it", () => {
    expect(formatHref("url", "javascript:alert(1)")).toBeNull();
    expect(formatHref("url", "data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(formatHref("url", "file:///etc/passwd")).toBeNull();
    expect(formatHref("url", "vbscript:msgbox(1)")).toBeNull();
  });

  it("refuses a url that does not parse as absolute", () => {
    expect(formatHref("url", "example.org/a")).toBeNull();
    expect(formatHref("url", "/relative/path")).toBeNull();
  });

  // A resolver path is built by concatenation, so an id carrying a separator,
  // whitespace, or a scheme could otherwise steer the final URL.
  it("refuses a doi or arxiv id that could steer its resolver path", () => {
    expect(formatHref("doi", "../../etc/passwd")).toBeNull();
    expect(formatHref("doi", "10.1000/x https://evil.test")).toBeNull();
    expect(formatHref("arxiv", "1706.03762 https://evil.test")).toBeNull();
    expect(formatHref("arxiv", "../1706.03762")).toBeNull();
    expect(formatHref("arxiv", "https://evil.test")).toBeNull();
  });

  // Containment is the ORIGIN check, not the identifier grammar — so it must
  // hold for a value that clears the grammar and still tries to re-base.
  it("refuses anything that leaves the fixed resolver origin", () => {
    expect(formatHref("doi", "10.1000/x")).toBe("https://doi.org/10.1000/x");
    for (const escape of ["//evil.test/x", "https://evil.test", "\\\\evil.test"]) {
      expect(formatHref("doi", escape), escape).toBeNull();
      expect(formatHref("arxiv", escape), escape).toBeNull();
    }
  });

  it("refuses a doi that does not match the registrant grammar", () => {
    expect(formatHref("doi", "not-a-doi")).toBeNull();
    expect(formatHref("doi", "10.1/short")).toBeNull();
    expect(formatHref("doi", "11.1000/wrong-prefix")).toBeNull();
  });

  it("refuses an unknown format even though validation should have caught it", () => {
    expect(formatHref("isbn", "978-3-16-148410-0")).toBeNull();
    expect(formatHref("", "https://example.org")).toBeNull();
    expect(formatHref(undefined as unknown as string, "https://example.org")).toBeNull();
  });

  it("refuses an empty, blank, or non-string value", () => {
    expect(formatHref("doi", "")).toBeNull();
    expect(formatHref("doi", "   ")).toBeNull();
    expect(formatHref("url", 42 as unknown as string)).toBeNull();
    expect(formatHref("url", null as unknown as string)).toBeNull();
  });

  // `__proto__` and friends resolve on a plain object literal; the resolver
  // table must not treat them as declared formats.
  it("refuses an inherited Object property masquerading as a format", () => {
    expect(formatHref("__proto__", "https://example.org")).toBeNull();
    expect(formatHref("constructor", "https://example.org")).toBeNull();
    expect(formatHref("toString", "https://example.org")).toBeNull();
  });
});

/**
 * A DOI suffix may contain almost any character, slashes included. An
 * over-tight grammar does not make the link safer — the origin is a fixed
 * literal — it just drops valid identifiers to plain text with no explanation.
 */
describe("formatHref resolves real-world DOI suffixes", () => {
  it("links a suffix containing a slash", () => {
    expect(formatHref("doi", "10.5061/dryad.abc/1")).toBe("https://doi.org/10.5061/dryad.abc/1");
  });

  it("links the punctuation-heavy legacy Wiley form", () => {
    const doi = "10.1002/(SICI)1097-0258(19980815)17:15<1661::AID-SIM968>3.0.CO;2-2";
    const href = formatHref("doi", doi);
    expect(href).not.toBeNull();
    expect(href!.startsWith("https://doi.org/10.1002/")).toBe(true);
  });

  it("normalises percent-encoding, so the validated string is the navigated one", () => {
    const href = formatHref("doi", "10.1000/a b".replace(" ", "%20"));
    expect(href).toBe("https://doi.org/10.1000/a%20b");
  });

});
