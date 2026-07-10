/**
 * @file test/connectors/review-pin.test.ts
 * @description Connector candidates require an operator-supplied body hash at approval.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import reviewApproveCommand from "../../src/commands/review-approve.js";
import reviewShowCommand from "../../src/commands/review-show.js";
import { writeCandidate } from "../../src/compiler/candidates.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const root = useTempRoot();

const BODY = [
  "---",
  "title: Paper",
  "x-llmwiki.connector:",
  "  connectorId: crossref",
  "  connectorVersion: \"1\"",
  "  sourceUrl: https://api.crossref.org/works/10.123/example",
  "  fetchedAt: 2026-07-06T00:00:00.000Z",
  `  contentHash: ${"a".repeat(64)}`,
  `  idempotencyKey: ${"c".repeat(64)}`,
  "  externalFields:",
  "    - title",
  "---",
  "Connector body",
].join("\n");
const SHA = (body: string): string => createHash("sha256").update(body).digest("hex");
const PROFILE = {
  schemaVersion: 1,
  profileId: "connector-pin-test",
  entities: {
    papers: {
      directory: "wiki/papers",
      fields: { title: { type: "string", required: true } },
      requiredFields: ["title"],
    },
  },
};

async function installProfile(): Promise<void> {
  const dir = path.join(root.dir, ".llmwiki");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "profile.json"), JSON.stringify(PROFILE, null, 2), "utf8");
}

async function seedConnectorCandidate(): Promise<string> {
  await installProfile();
  const candidate = await writeCandidate(root.dir, {
    title: "paper",
    slug: "paper",
    summary: "",
    sources: [],
    body: BODY,
    reviewMode: "connector",
    heldReasons: [{ code: "connector-fetched" }],
    targetEntityType: "papers",
    connectorProvenance: {
      connectorId: "crossref",
      connectorVersion: "1",
      sourceUrl: "https://api.crossref.org/works/10.123/example",
      fetchedAt: "2026-07-06T00:00:00.000Z",
      contentHash: "a".repeat(64),
      draftContentHash: "b".repeat(64),
      idempotencyKey: "c".repeat(64),
    },
  });
  return candidate.id;
}

/** Path to one candidate JSON record in the temp project. */
function candidateFile(id: string): string {
  return path.join(root.dir, ".llmwiki", "candidates", `${id}.json`);
}

/** Edit a persisted candidate record in place. */
async function mutateCandidate(id: string, edit: (raw: Record<string, any>) => void): Promise<void> {
  const file = candidateFile(id);
  const raw = JSON.parse(await readFile(file, "utf8"));
  edit(raw);
  await writeFile(file, JSON.stringify(raw, null, 2), "utf8");
}

/** Remove mutable metadata that used to be mistaken for the connector-origin boundary. */
function downgradeConnectorMetadata(raw: Record<string, any>): void {
  raw.reviewMode = "forced";
  delete raw.connectorProvenance;
}

/** Capture review-show's console output for one candidate id. */
async function captureReviewShow(id: string): Promise<string> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await reviewShowCommand(id);
    return log.mock.calls.flat().join("\n");
  } finally {
    log.mockRestore();
  }
}

describe("connector review approval pin", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("review show prints a live hash of candidate.body, not stored draftContentHash", async () => {
    const id = await seedConnectorCandidate();
    const shown = await captureReviewShow(id);
    expect(shown).toContain(`draft-content-hash: ${SHA(BODY)}`);
    expect(shown).not.toContain("b".repeat(64));
  });

  it("connector approval without --draft-content-hash refuses before promotion", async () => {
    const id = await seedConnectorCandidate();
    await reviewApproveCommand(id, {});
    expect(process.exitCode).toBe(1);
  });

  it("connector approval with stale hash refuses after body tamper", async () => {
    const id = await seedConnectorCandidate();
    await mutateCandidate(id, (raw) => {
      raw.body = "---\ntitle: Paper\n---\nChanged";
      raw.connectorProvenance.draftContentHash = SHA(raw.body);
    });
    await reviewApproveCommand(id, { draftContentHash: SHA(BODY) });
    expect(process.exitCode).toBe(1);
  });

  it("connector approval still requires the pin when candidate metadata is downgraded", async () => {
    const id = await seedConnectorCandidate();
    await mutateCandidate(id, downgradeConnectorMetadata);

    await reviewApproveCommand(id, {});

    expect(process.exitCode).toBe(1);
  });

  it("review show still prints the connector pin when candidate metadata is downgraded", async () => {
    const id = await seedConnectorCandidate();
    await mutateCandidate(id, downgradeConnectorMetadata);

    const shown = await captureReviewShow(id);
    expect(shown).toContain(`draft-content-hash: ${SHA(BODY)}`);
    expect(shown).toContain("UNTRUSTED");
  });
});
