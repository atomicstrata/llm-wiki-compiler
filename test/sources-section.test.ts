/**
 * Unit tests for the `## Sources` section toggle and its effect on the page
 * prompt.
 *
 * Default behaviour (no env, no flag) must keep the page prompt byte-identical
 * to the previous implementation. Opting out must remove only the section
 * request — the inline citation contract and the `sources:` frontmatter that
 * carry provenance are not part of this switch.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  applySourcesSectionOption,
  sourcesSectionEnabled,
} from "../src/utils/sources-section.js";
import { buildPagePrompt } from "../src/compiler/prompts.js";

const ENV_KEY = "LLMWIKI_SOURCES_SECTION";
const SECTION_REQUEST = "Include a ## Sources section";

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("sourcesSectionEnabled", () => {
  it("defaults to enabled when the env var is unset", () => {
    expect(sourcesSectionEnabled()).toBe(true);
  });

  it.each(["0", "false", "off", "no"])("treats %s as disabled", value => {
    process.env[ENV_KEY] = value;
    expect(sourcesSectionEnabled()).toBe(false);
  });

  it("ignores surrounding whitespace and case", () => {
    process.env[ENV_KEY] = "  OFF  ";
    expect(sourcesSectionEnabled()).toBe(false);
  });

  it("stays enabled for any other value", () => {
    process.env[ENV_KEY] = "on";
    expect(sourcesSectionEnabled()).toBe(true);
  });
});

describe("applySourcesSectionOption", () => {
  it("leaves the env var untouched when the flag was not passed", () => {
    applySourcesSectionOption(undefined);
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it("leaves an existing opt-out in place on commander's default true", () => {
    process.env[ENV_KEY] = "off";
    applySourcesSectionOption(true);
    expect(sourcesSectionEnabled()).toBe(false);
  });

  it("disables the section when --no-sources-section was passed", () => {
    applySourcesSectionOption(false);
    expect(sourcesSectionEnabled()).toBe(false);
  });
});

describe("buildPagePrompt honours the toggle", () => {
  it("requests the section by default", () => {
    expect(buildPagePrompt("Concept", "src", "", "")).toContain(SECTION_REQUEST);
  });

  it("omits the request when disabled", () => {
    process.env[ENV_KEY] = "off";
    expect(buildPagePrompt("Concept", "src", "", "")).not.toContain(SECTION_REQUEST);
  });

  it("keeps the inline citation contract when disabled", () => {
    process.env[ENV_KEY] = "off";
    const out = buildPagePrompt("Concept", "src", "", "");
    expect(out).toContain("^[filename.md:START-END]");
    expect(out).toContain("Draw facts only from the provided source material.");
  });

  it("drops the line rather than blanking it", () => {
    const enabled = buildPagePrompt("Concept", "src", "", "");
    process.env[ENV_KEY] = "off";
    const disabled = buildPagePrompt("Concept", "src", "", "");
    expect(disabled.split("\n").length).toBe(enabled.split("\n").length - 1);
  });
});
