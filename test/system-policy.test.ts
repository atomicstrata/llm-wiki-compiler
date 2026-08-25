/**
 * @file test/system-policy.test.ts
 * @description The caller policy: how it reaches the prompts, and why it is a
 * prompt modifier rather than a plain option.
 *
 * A policy changes what the compile prompt ASKS FOR without changing any source
 * byte, which is exactly the shape `compiler/prompt-modifiers.ts` exists to
 * handle. Registering it there is what makes changing a policy invalidate the
 * pages compiled under the previous one; without that, a settled project reports
 * "Nothing to compile" and silently keeps content generated under a policy the
 * operator has already replaced.
 *
 * The DIGEST enters the modifier set, never the text. The set is hashed into
 * `state.json`, stamped on every page's frontmatter, and published through the
 * JSON export, so carrying the prose would put an operator's editorial
 * instructions into three artifacts that outlive the run.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  activePromptModifiers,
  activeSystemPolicy,
  promptModifiersChanged,
  promptModifiersDigest,
  withRunSystemPolicy,
} from "../src/compiler/prompt-modifiers.js";
import { PROMPT_VERSION, buildPagePrompt, buildExtractionPrompt } from "../src/compiler/prompts.js";

const LANG = "LLMWIKI_OUTPUT_LANG";
afterEach(() => { delete process.env[LANG]; });

/** Resolve `fn` under `policy`, returning its value. */
function under<T>(policy: string | undefined, fn: () => T): Promise<T> {
  return withRunSystemPolicy(policy, async () => fn());
}

describe("the policy as run state", () => {
  it("is absent outside a run", () => {
    expect(activeSystemPolicy()).toBeUndefined();
  });

  it("is trimmed, and blank is the same as absent", async () => {
    expect(await under("  Prefer plain language.  ", activeSystemPolicy)).toBe("Prefer plain language.");
    expect(await under("   ", activeSystemPolicy)).toBeUndefined();
    expect(await under("", activeSystemPolicy)).toBeUndefined();
  });

  it("does not outlive the run, even when the run throws", async () => {
    await expect(
      withRunSystemPolicy("A", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(activeSystemPolicy()).toBeUndefined();
  });

  // The SDK documents that concurrent calls are fully isolated with no global
  // state, and the compile lock is per ROOT, so two callers compiling different
  // projects genuinely overlap in one process. A save-and-restore module
  // variable handles nesting and fails here: whichever run finishes first
  // restores the value it captured, which belongs to neither. That implementation
  // produced ["Policy B", undefined] on this test - one project reading
  // another's policy, and the other losing its own.
  /**
   * Start two policy runs, let both yield, then read `observe` inside each.
   *
   * The yield is the point: a save-and-restore module variable only fails once
   * the two runs interleave, so a test that reads without awaiting would pass
   * against the broken implementation.
   */
  async function observeOverlapping<T>(observe: () => T): Promise<[T, T]> {
    const seen: T[] = [];
    const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
    const run = (policy: string, slot: number) =>
      withRunSystemPolicy(policy, async () => {
        await pause();
        seen[slot] = observe();
      });
    await Promise.all([run("Policy A", 0), run("Policy B", 1)]);
    return [seen[0], seen[1]];
  }

  it("keeps overlapping runs isolated from each other", async () => {
    expect(await observeOverlapping(activeSystemPolicy)).toEqual(["Policy A", "Policy B"]);
  });

  it("keeps the modifier digest isolated across overlapping runs too", async () => {
    // The leak is not confined to prompt text: the policy feeds the digest that
    // reaches state.json, candidates and page provenance.
    const [a, b] = await observeOverlapping(promptModifiersDigest);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the policy is a prompt modifier", () => {
  it("contributes a digest, never the policy text", async () => {
    const policy = "Never mention internal codenames.";
    const modifiers = await under(policy, activePromptModifiers);
    expect(modifiers.policy).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(modifiers)).not.toContain("codenames");
  });

  it("invalidates when one policy replaces another", async () => {
    const a = await under("Policy A", promptModifiersDigest);
    const changed = await under("Policy B", () => promptModifiersChanged(a));
    expect(changed).toBe(true);
  });

  it("invalidates when a policy is cleared", async () => {
    const a = await under("Policy A", promptModifiersDigest);
    expect(promptModifiersChanged(a)).toBe(true);
  });

  it("leaves a project with no policy untouched", async () => {
    const none = promptModifiersDigest();
    expect(none).toBe("");
    expect(await under(undefined, () => promptModifiersChanged(none))).toBe(false);
    expect(await under("   ", () => promptModifiersChanged(none))).toBe(false);
  });

  it("composes with the output language rather than replacing it", async () => {
    process.env[LANG] = "Japanese";
    const modifiers = await under("Policy A", activePromptModifiers);
    expect(Object.keys(modifiers).sort()).toEqual(["lang", "policy"]);
  });
});

describe("the policy in the prompt", () => {
  const POLICY = "Prefer British spelling.";

  it("is absent by default, leaving the prompt as it was", () => {
    expect(buildPagePrompt("C", "src", "", "")).not.toContain(POLICY);
  });

  it("appears in the page prompt before the source material", async () => {
    const prompt = await under(POLICY, () => buildPagePrompt("C", "SRC-BODY", "", ""));
    expect(prompt).toContain(POLICY);
    expect(prompt.indexOf(POLICY)).toBeLessThan(prompt.indexOf("--- SOURCE MATERIAL ---"));
  });

  it("appears in the extraction prompt before the source document", async () => {
    const prompt = await under(POLICY, () => buildExtractionPrompt("SRC-BODY", ""));
    expect(prompt).toContain(POLICY);
    expect(prompt.indexOf(POLICY)).toBeLessThan(prompt.indexOf("--- SOURCE DOCUMENT ---"));
  });

  it("is introduced as additive, not as a replacement", async () => {
    const prompt = await under(POLICY, () => buildPagePrompt("C", "src", "", ""));
    expect(prompt).toContain("in addition to every built-in instruction above");
    expect(prompt).toContain("Draw facts only from the provided source material.");
  });
});

describe("PROMPT_VERSION", () => {
  // The constant names the prompt IMPLEMENTATION, so the conditional policy
  // branch is a new generation. Pinned because nothing else in the repo asserts
  // its value, and a silent revert would mislabel every page compiled after it.
  it("is v2, the generation that can carry a caller policy", () => {
    expect(PROMPT_VERSION).toBe("v2");
  });
});
