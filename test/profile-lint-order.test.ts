/**
 * Frozen ordered findings captured before the tier refactor. Uses the existing
 * default corpus and artifact/lifecycle profile to guard flat object parity.
 */
import { expect, it } from "vitest";
import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { lint } from "../src/linter/index.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";
import { buildParityCorpus } from "./fixtures/parity-corpus.js";
import { researchArtifactPreconditionProfile } from "./fixtures/artifact-precondition-profiles.js";
import { writeMarkdownPage, writeProfileFile } from "./fixtures/profile-fixtures.js";

const env = useLintTempRoot("tier-order");
const EXPECTED_PROFILE = [
  { rule: "profile/field-violation", severity: "warning", file: "<ROOT>/wiki/experiments/bad.md", entityType: "experiments",
    message: 'Field "stage" value "impossible" is not one of ["running","complete"].' },
  { rule: "empty-page", severity: "warning", file: "<ROOT>/wiki/experiments/bad.md", entityType: "experiments",
    message: "Page body is empty or too short (< 50 chars)" },
  { rule: "invalid-lifecycle-state", severity: "warning", file: "<ROOT>/wiki/experiments/bad.md", entityType: "experiments",
    message: 'lifecycle field "stage" value "impossible" is not a declared state' },
  { rule: "empty-page", severity: "warning", file: "<ROOT>/wiki/experiments/exp.md", entityType: "experiments",
    message: "Page body is empty or too short (< 50 chars)" },
  { rule: "relation-store-too-new", severity: "error", file: "wiki/graph/relations.jsonl",
    message: "relation store schemaVersion 99 exceeds supported 2" },
  { rule: "event-store-too-new", severity: "error", file: "wiki/graph/events.jsonl",
    message: "event store schemaVersion 99 exceeds supported 2" },
  { rule: "gated-page-required-artifact-missing", severity: "error", file: "<ROOT>/wiki/experiments/exp.md", entityType: "experiments",
    message: 'field "result" required by lifecycle state "complete" carries no resolvable experiment-result artifact ref' },
];

it("preserves the exact default flat golden", async () => {
  const root = await realpath(env.dir);
  await buildParityCorpus(root);
  const expected = JSON.parse(await readFile(new URL("./parity/__golden__/sdk.lint.json", import.meta.url), "utf8"));
  expect(JSON.parse(JSON.stringify(await lint(root)).replaceAll(root, "<ROOT>"))).toEqual(expected);
});

it("preserves ordered structure, content, lifecycle, relation, event and artifact findings", async () => {
  const root = await realpath(env.dir);
  await writeProfileFile(root, researchArtifactPreconditionProfile());
  await writeMarkdownPage(root, "wiki/experiments", "bad", "---\ntitle: Bad\nstage: impossible\n---\nHi\n");
  await writeMarkdownPage(root, "wiki/experiments", "exp", "---\ntitle: E\nstage: complete\n---\nBody.\n");
  await mkdir(path.join(root, "wiki/graph"), { recursive: true });
  for (const kind of ["relation", "event"]) {
    await writeFile(path.join(root, `wiki/graph/${kind}s.jsonl`), `{"kind":"${kind}-store-header","schemaVersion":99}\n`);
  }
  const found = JSON.parse(JSON.stringify((await lint(root)).results).replaceAll(root, "<ROOT>"));
  expect(found).toEqual(EXPECTED_PROFILE);
});
