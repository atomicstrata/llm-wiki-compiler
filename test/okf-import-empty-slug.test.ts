import { describe, it, expect } from "vitest";
import { isWritable } from "../src/commands/import.js";
import type { MappedOkfPage } from "../src/import/types.js";

const VALID_BODY = "---\ntitle: A\n---\n\nBody.\n";

function page(over: Partial<MappedOkfPage>): MappedOkfPage {
  return {
    slug: "a", title: "A", summary: "", sources: [],
    targetDirectory: "concepts", okfPath: "concepts/a.md", body: VALID_BODY, ...over,
  };
}

describe("isWritable: empty-slug guard", () => {
  it("rejects an empty slug even with a valid body (would write concepts/.md)", () => {
    expect(isWritable(page({ slug: "" }))).toBe(false);
  });
  it("rejects an empty/title-less body even with a real slug", () => {
    expect(isWritable(page({ body: "---\ntitle: A\n---\n\n" }))).toBe(false);
  });
  it("accepts a real slug with a valid body", () => {
    expect(isWritable(page({}))).toBe(true);
  });
});
