/**
 * @file test/prompt-modifiers.test.ts
 * @description The prompt-modifier set, its digest, and the change test that
 * decides whether flipping one invalidates already-compiled pages.
 *
 * `detectChanges` classifies a source by the SHA-256 of its bytes alone, so
 * before this `llmwiki compile --lang Japanese` over a settled project reported
 * "Nothing to compile" and left every page in the previous language. The digest
 * here is what makes a modifier an input to the page prompt the same way the
 * source text is.
 *
 * The migration edge is the interesting one: an ABSENT recorded digest reads as
 * "none were selected" rather than as its own state. Reading it as "no
 * difference" instead would be silently wrong, because the no-op compile path
 * never flushes state — a project with nothing to compile would never record a
 * first digest, and the case this exists for would stay broken forever.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  activePromptModifiers,
  promptModifierPairs,
  promptModifiersChanged,
  promptModifiersDigest,
} from "../src/compiler/prompt-modifiers.js";

const LANG = "LLMWIKI_OUTPUT_LANG";
afterEach(() => { delete process.env[LANG]; });

describe("the active modifier set", () => {
  it("is empty when the operator selected none", () => {
    expect(activePromptModifiers()).toEqual({});
    expect(promptModifierPairs()).toEqual([]);
  });

  it("carries the output language when one is set", () => {
    process.env[LANG] = "Japanese";
    expect(activePromptModifiers()).toEqual({ lang: "Japanese" });
    expect(promptModifierPairs()).toEqual(["lang=Japanese"]);
  });
});

describe("the digest", () => {
  it('is "" for the empty set, not the hash of an empty string', () => {
    expect(promptModifiersDigest()).toBe("");
  });

  it("is a stable hex digest once a modifier is set", () => {
    process.env[LANG] = "Japanese";
    expect(promptModifiersDigest()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("separates two different selections", () => {
    process.env[LANG] = "Japanese";
    const japanese = promptModifiersDigest();
    process.env[LANG] = "Spanish";
    expect(promptModifiersDigest()).not.toBe(japanese);
  });

  it("is stable across reads of the same selection", () => {
    process.env[LANG] = "Japanese";
    expect(promptModifiersDigest()).toBe(promptModifiersDigest());
  });
});

describe("the change test", () => {
  it("reports no change when the recorded selection still matches", () => {
    process.env[LANG] = "Japanese";
    expect(promptModifiersChanged(promptModifiersDigest())).toBe(false);
  });

  it("reports a change when a modifier is newly set", () => {
    process.env[LANG] = "Japanese";
    expect(promptModifiersChanged("")).toBe(true);
  });

  it("reports a change when the only modifier is cleared", () => {
    process.env[LANG] = "Japanese";
    const recorded = promptModifiersDigest();
    delete process.env[LANG];
    expect(promptModifiersChanged(recorded)).toBe(true);
  });

  it("costs an untouched project nothing when it upgrades", () => {
    // Absent digest, no modifier selected: the common upgrade, and it must not
    // charge a recompile.
    expect(promptModifiersChanged(undefined)).toBe(false);
  });

  it("invalidates once for a project already using a modifier when it upgrades", () => {
    process.env[LANG] = "Japanese";
    expect(promptModifiersChanged(undefined)).toBe(true);
  });
});
