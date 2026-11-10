/**
 * @file test/t1-journey-compare.test.ts
 * @description Regression witnesses for how the transparent-disk (T1) journey
 * driver makes two runs comparable (`fixtures/t1-journey-compare.ts`).
 *
 * The driver must hide generated metadata and NOTHING else. Each case changes
 * one thing in a realistic record and states whether the comparison must see
 * it: a clock reading or candidate id in prose must stay visible, the same
 * shapes in their named metadata positions must not, and an embeddings
 * fingerprint is replaced only after it is proven to be the scenario's own
 * mock identity.
 */

import { describe, expect, it } from "bun:test";
import {
  comparableFile, comparableLink, comparableOutput, comparablePath,
  EMBEDDING_MODEL, expectedEmbeddingFingerprint, type RunIdentity,
} from "./fixtures/t1-journey-compare.js";

const IDENTITY: RunIdentity = {
  base: "/tmp/run-a", candidateIds: ["existing-topic-ab12cd34"], embeddingEndpoint: "http://127.0.0.1:4010/v1", driverPid: 4242,
};

const CLOCK = "2026-10-08T07:47:34.307Z";
const PROSE = "The event of 2026-01-01T01:02:03.000Z is filed as existing-topic-12345678 under /tmp/run-a/notes.";

/** A page as the compiler writes one: generated clocks in frontmatter, then prose. */
function page(clock: string, prose: string): string {
  return `---\ntitle: Existing Topic\ncreatedAt: "${clock}"\nupdatedAt: "${clock}"\n---\n\n${prose}\n`;
}

/** A candidate record as the store writes one. */
function candidate(id: string, clock: string, prose: string): string {
  const record = { id, title: "Existing Topic", body: page(clock, prose), sourceStates: { "alpha.md": { hash: "h", compiledAt: clock } }, generatedAt: clock };
  return JSON.stringify(record, null, 2);
}

const CANDIDATE_FILE = ".llmwiki/candidates/existing-topic-ab12cd34.json";

/** The comparable text of the candidate file for one variation. */
function comparedCandidate(id: string, clock: string, prose: string): string {
  return comparableFile(CANDIDATE_FILE, candidate(id, clock, prose), IDENTITY);
}

describe("T1 comparison hides only named generated metadata", () => {
  const baseline = comparedCandidate("existing-topic-ab12cd34", CLOCK, PROSE);

  it("is unchanged by another run's clock readings in the named positions", () => {
    expect(comparedCandidate("existing-topic-ab12cd34", "2027-01-02T03:04:05.006Z", PROSE)).toBe(baseline);
    expect(baseline).toContain(PROSE);
    expect(baseline).not.toContain(CLOCK);
  });

  it("sees a changed clock-shaped or id-shaped string in a candidate body's prose", () => {
    expect(comparedCandidate("existing-topic-ab12cd34", CLOCK, PROSE.replace("2026-01-01", "2026-02-02"))).not.toBe(baseline);
    expect(comparedCandidate("existing-topic-ab12cd34", CLOCK, PROSE.replace("12345678", "87654321"))).not.toBe(baseline);
    expect(comparedCandidate("existing-topic-ab12cd34", CLOCK, PROSE.replace("/tmp/run-a", "/tmp/run-b"))).not.toBe(baseline);
  });

  it("keeps a record id that is not the file's own generated id", () => {
    expect(comparedCandidate("existing-topic-99999999", CLOCK, PROSE)).not.toBe(baseline);
    expect(comparablePath(CANDIDATE_FILE)).toBe(".llmwiki/candidates/existing-topic-<ID>.json");
    expect(comparablePath("wiki/concepts/existing-topic-ab12cd34.md")).toBe("wiki/concepts/existing-topic-ab12cd34.md");
  });

  it("tokenizes a page's frontmatter clocks but nothing in its prose, and nothing at all in a source", () => {
    const pageFile = "wiki/concepts/existing-topic.md";
    expect(comparableFile(pageFile, page("2027-01-02T03:04:05.006Z", PROSE), IDENTITY)).toBe(comparableFile(pageFile, page(CLOCK, PROSE), IDENTITY));
    expect(comparableFile(pageFile, page(CLOCK, PROSE.replace("2026-01-01", "2026-02-02")), IDENTITY))
      .not.toBe(comparableFile(pageFile, page(CLOCK, PROSE), IDENTITY));
    expect(comparableFile("sources/alpha.md", page(CLOCK, PROSE), IDENTITY)).toBe(page(CLOCK, PROSE));
  });

  it("tokenizes output only at known positions and a link only at its leading temp directory", () => {
    const output = `? \u001b[34mCandidate ready: existing-topic-ab12cd34 (existing-topic)\u001b[0m\nnote ${PROSE} ${CLOCK} existing-topic-ab12cd34\n`;
    expect(comparableOutput(output, IDENTITY)).toBe(output.replace("ready: existing-topic-ab12cd34", "ready: existing-topic-<ID>"));
    expect(comparableLink("/tmp/run-a/outside/secret.md", IDENTITY)).toBe("<BASE>/outside/secret.md");
    expect(comparableLink("/elsewhere/tmp/run-a/secret.md", IDENTITY)).toBe("/elsewhere/tmp/run-a/secret.md");
  });
});

describe("T1 comparison verifies the embeddings identity before hiding it", () => {
  /** An embeddings store as the compiler writes one. */
  function store(fingerprint: string, model = EMBEDDING_MODEL, vector = [0.25, -0.5]): string {
    return JSON.stringify({ version: 3, model, entries: [{ pageId: "concepts/a", embeddingTextHash: "2b44", vector, updatedAt: CLOCK }], fingerprint }, null, 2);
  }
  const mockIdentity = expectedEmbeddingFingerprint(IDENTITY.embeddingEndpoint);
  const compared = (text: string): string => comparableFile(".llmwiki/embeddings.json", text, IDENTITY);

  it("accepts exactly backend, model and endpoint joined by NUL, and nothing else", () => {
    // sha256("openai\\0text-embedding-3-small\\0http://127.0.0.1:4010/v1"), computed outside this code base.
    expect(mockIdentity).toBe("914d7e97629603690b1daaaf24d280990f65a36f00aebffa77d945ad40ba421a");
    expect(compared(store(mockIdentity))).toContain('"fingerprint": "<MOCK-ENDPOINT-IDENTITY>"');
    expect(() => compared(store("0".repeat(64)))).toThrow(/not .*identity of openai/u);
    expect(() => compared(store(expectedEmbeddingFingerprint("http://127.0.0.1:9/v1")))).toThrow(/fingerprint/u);
  });

  it("still compares the model, vectors and content hashes of a store whose identity is verified", () => {
    const baseline = compared(store(mockIdentity));
    expect(compared(store(mockIdentity, "another-model"))).not.toBe(baseline);
    expect(compared(store(mockIdentity, EMBEDDING_MODEL, [0.25, -0.75]))).not.toBe(baseline);
    expect(compared(store(mockIdentity).replace("2b44", "2b45"))).not.toBe(baseline);
    expect(compared(store(mockIdentity).replace(CLOCK, "2027-01-02T03:04:05.006Z"))).toBe(baseline);
  });
});
