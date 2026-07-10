/**
 * Tests for the pure `pageEmbedSurfaces` embedding-eligibility predicate.
 *
 * Covers the spec §4.2 truth table (omitted/true/false tri-state for
 * includeInSearch × includeInContext), the legacy orphaned/untitled skip
 * (codex#4), and the profile-invalid typed-page exclusion.
 */

import { describe, it, expect } from "vitest";
import { pageEmbedSurfaces } from "../src/utils/embed-eligibility.js";
import type { RetrievalDef } from "../src/profile/types.js";

// ─── helpers ────────────────────────────────────────────────────────────────

const meta = (overrides: Record<string, unknown> = {}) => ({
  title: "My Page",
  ...overrides,
});

const conceptInput = (metaOverrides: Record<string, unknown> = {}) => ({
  meta: meta(metaOverrides),
  pageKind: "concept" as const,
});

const typedInput = (retrieval: RetrievalDef | undefined, invalid = false) => ({
  meta: meta(),
  pageKind: "typed" as const,
  retrieval,
  isProfileInvalid: invalid,
});

// ─── truth table (typed pages, every meaningful omitted/true/false combo) ───

describe("pageEmbedSurfaces — RetrievalDef truth table", () => {
  it("omitted S, omitted C → embedded, inSearch, inContext", () => {
    expect(pageEmbedSurfaces(typedInput({}))).toEqual({
      embedded: true, inSearch: true, inContext: true,
    });
  });

  it("S=true, C=true → embedded, inSearch, inContext", () => {
    expect(pageEmbedSurfaces(typedInput({ includeInSearch: true, includeInContext: true }))).toEqual({
      embedded: true, inSearch: true, inContext: true,
    });
  });

  it("S=false, C=false → not embedded, not inSearch, not inContext", () => {
    expect(pageEmbedSurfaces(typedInput({ includeInSearch: false, includeInContext: false }))).toEqual({
      embedded: false, inSearch: false, inContext: false,
    });
  });

  it("S=false, C=true → embedded, not inSearch, inContext", () => {
    expect(pageEmbedSurfaces(typedInput({ includeInSearch: false, includeInContext: true }))).toEqual({
      embedded: true, inSearch: false, inContext: true,
    });
  });

  it("S=true, C=false → embedded, inSearch, not inContext", () => {
    expect(pageEmbedSurfaces(typedInput({ includeInSearch: true, includeInContext: false }))).toEqual({
      embedded: true, inSearch: true, inContext: false,
    });
  });

  it("S=false, omitted C → embedded (C defaults eligible), not inSearch", () => {
    expect(pageEmbedSurfaces(typedInput({ includeInSearch: false }))).toEqual({
      embedded: true, inSearch: false, inContext: true,
    });
  });

  it("omitted S, C=false → embedded (S defaults eligible), not inContext", () => {
    expect(pageEmbedSurfaces(typedInput({ includeInContext: false }))).toEqual({
      embedded: true, inSearch: true, inContext: false,
    });
  });
});

// ─── legacy orphaned/untitled skip for concepts/queries (codex#4) ────────────

describe("pageEmbedSurfaces — legacy orphaned/untitled skip", () => {
  it("normal concept (title, not orphaned) → embedded with S=C=true", () => {
    expect(pageEmbedSurfaces(conceptInput())).toEqual({
      embedded: true, inSearch: true, inContext: true,
    });
  });

  it("orphaned concept → not embedded", () => {
    expect(pageEmbedSurfaces(conceptInput({ orphaned: true }))).toEqual({
      embedded: false, inSearch: false, inContext: false,
    });
  });

  it("untitled concept (no title key) → not embedded", () => {
    const { title: _drop, ...noTitle } = meta();
    expect(pageEmbedSurfaces({ meta: noTitle, pageKind: "concept" })).toEqual({
      embedded: false, inSearch: false, inContext: false,
    });
  });

  it("title is non-string (number) → not embedded", () => {
    expect(pageEmbedSurfaces(conceptInput({ title: 42 }))).toEqual({
      embedded: false, inSearch: false, inContext: false,
    });
  });
});

// ─── profile-invalid typed page ──────────────────────────────────────────────

describe("pageEmbedSurfaces — profile-invalid typed page", () => {
  it("invalid typed page → not embedded regardless of RetrievalDef", () => {
    expect(pageEmbedSurfaces(typedInput(undefined, true))).toEqual({
      embedded: false, inSearch: false, inContext: false,
    });
  });

  it("invalid typed page with permissive RetrievalDef → still not embedded", () => {
    expect(pageEmbedSurfaces(typedInput({ includeInSearch: true, includeInContext: true }, true))).toEqual({
      embedded: false, inSearch: false, inContext: false,
    });
  });
});
