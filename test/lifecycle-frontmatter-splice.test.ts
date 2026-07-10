/**
 * @file test/lifecycle-frontmatter-splice.test.ts
 * @description Unit tests for the raw-frontmatter splice
 * ({@link rebuildLifecycleFrontmatter}) that the lifecycle transition uses to
 * rebuild a page's frontmatter without retyping untouched fields.
 *
 * REGRESSION (the bug these pin): when an UPSERTED key already exists on the page
 * as a MULTI-LINE value — a YAML block list, a nested block mapping, or a block
 * scalar (`|`/`>`) — replacing only the single `key:` line orphans the value's
 * CONTINUATION lines. The orphaned lines then merge with the freshly-rendered
 * value, so the written page parses to old+new (a `string[]` becomes
 * `["new","oldA","oldB"]`; a scalar-over-list becomes a malformed dash-joined
 * string). The splice MUST drop a replaced key's continuation lines so the page
 * re-parses to EXACTLY the validated value — the splice-vs-validated consistency.
 */

import { describe, it, expect } from "vitest";
import { rebuildLifecycleFrontmatter } from "../src/trust/lifecycle-frontmatter.js";
import { parseFrontmatter } from "../src/utils/markdown.js";

/** Re-parse the spliced frontmatter block and return its meta map. */
function reparse(block: string): Record<string, unknown> {
  return parseFrontmatter(`${block}\n\nBody.\n`).meta;
}

describe("rebuildLifecycleFrontmatter drops a replaced key's continuation lines", () => {
  it("replaces a pre-existing block list with the validated string[] exactly (not merged)", () => {
    const raw = "lifecycle: draft\nreviewers:\n  - oldA\n  - oldB\ntitle: Hello";
    const accepted = { reviewers: ["alice"] };
    const block = rebuildLifecycleFrontmatter(raw, "lifecycle", "review", accepted);
    const meta = reparse(block);
    expect(meta.reviewers).toEqual(["alice"]); // NOT ["alice","oldA","oldB"]
    expect(meta.lifecycle).toBe("review");
    expect(meta.title).toBe("Hello"); // untouched neighbour preserved
  });

  it("replaces a pre-existing block list with a scalar cleanly (no dash-joined garbage)", () => {
    const raw = "lifecycle: draft\nreviewer:\n  - oldA\n  - oldB";
    const block = rebuildLifecycleFrontmatter(raw, "lifecycle", "review", { reviewer: "alice" });
    expect(reparse(block).reviewer).toBe("alice");
  });

  it("replaces a pre-existing block scalar (|) value cleanly", () => {
    const raw = "lifecycle: draft\nnotes: |\n  line one\n  line two\ntitle: Hello";
    const block = rebuildLifecycleFrontmatter(raw, "lifecycle", "review", { notes: "fresh" });
    const meta = reparse(block);
    expect(meta.notes).toBe("fresh");
    expect(meta.title).toBe("Hello");
  });

  it("replaces a pre-existing nested block mapping cleanly", () => {
    const raw = "lifecycle: draft\nmeta:\n  a: 1\n  b: 2\ntitle: Hello";
    const block = rebuildLifecycleFrontmatter(raw, "lifecycle", "review", { meta: { c: 3 } });
    const meta = reparse(block);
    expect(meta.meta).toEqual({ c: 3 }); // NOT {a:1,b:2,c:3}
    expect(meta.title).toBe("Hello");
  });

  it("leaves a scalar/date key byte-unchanged when it is NOT upserted", () => {
    const raw = "created: 2024-01-15\nlifecycle: draft\nreviewers:\n  - oldA";
    const block = rebuildLifecycleFrontmatter(raw, "lifecycle", "review", { reviewers: ["alice"] });
    expect(block).toContain("created: 2024-01-15"); // untouched date stays byte-for-byte
    expect(reparse(block).reviewers).toEqual(["alice"]);
  });
});
