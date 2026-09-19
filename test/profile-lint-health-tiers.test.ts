/**
 * Feed actual store-check findings through tier construction, including rare
 * fail-closed read faults. Only the failing I/O boundary is injected; check
 * mapping, entity collection, artifact validation and partitioning are real.
 */
import { afterEach, expect, it, vi } from "vitest";
import * as events from "../src/events/store-read.js";
import * as relations from "../src/relations/store-read.js";
import * as artifacts from "../src/artifacts/resolve.js";
import { EventStoreCorruptError, EventStoreTooNewError, EventStoreSymlinkError, EventStoreFullError } from "../src/events/types.js";
import { RelationStoreCorruptError, RelationStoreTooNewError, RelationStoreSymlinkError } from "../src/relations/types.js";
import { GraphDirConfinementError } from "../src/utils/jsonl-store.js";
import { PrivateDirConfinementError } from "../src/utils/private-dir.js";
import { checkEventChain } from "../src/profile/event-lint.js";
import { checkRelationStore } from "../src/profile/relation-lint.js";
import { groupByDeclaredTier, tieredReport } from "../src/linter/tiers.js";
import { lintBothViews } from "../src/linter/index.js";
import { profileRuleTiers } from "../src/profile/lint-registry.js";
import type { LintResult } from "../src/linter/types.js";
import { researchArtifactPreconditionProfile } from "./fixtures/artifact-precondition-profiles.js";
import { writeMarkdownPage, writeProfileFile } from "./fixtures/profile-fixtures.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";

const env = useLintTempRoot("health-tiers");
const profile = researchArtifactPreconditionProfile();
afterEach(() => vi.restoreAllMocks());

/** Assert the real check emitted exactly its declared deterministic finding. */
function expectDeterministicFinding(found: LintResult[], rule: string): void {
  expect(found.map((r) => r.rule)).toEqual([rule]);
  expect(tieredReport(groupByDeclaredTier(found, profileRuleTiers(profile))).deterministic).toEqual(found);
}

it.each([
  [new EventStoreCorruptError("broken"), "event-store-corrupt"],
  [new EventStoreTooNewError(99, 1), "event-store-too-new"],
  [new EventStoreSymlinkError("symlink"), "event-store-symlink"],
  [new EventStoreFullError(), "event-store-full"],
  [new GraphDirConfinementError("graph"), "event-store-graph-dir"],
  [new PrivateDirConfinementError("private"), "event-store-private-dir"],
] as const)("tiers actual event failure %s as %s", async (error, rule) => {
  vi.spyOn(events, "readEvents").mockRejectedValue(error);
  const found = await checkEventChain(env.dir);
  expectDeterministicFinding(found, rule);
});

it.each([
  [new RelationStoreCorruptError("broken"), "relation-store-corrupt"],
  [new RelationStoreTooNewError(99, 1), "relation-store-too-new"],
  [new RelationStoreSymlinkError("symlink"), "relation-store-symlink"],
  [new GraphDirConfinementError("graph"), "relation-store-graph-dir"],
] as const)("tiers actual relation failure %s as %s", async (error, rule) => {
  vi.spyOn(relations, "readRelations").mockRejectedValue(error);
  const found = await checkRelationStore(env.dir, [], profile);
  expectDeterministicFinding(found, rule);
});

it.each([
  "artifact-dangling", "artifact-unreadable", "artifact-bytes-tampered",
  "artifact-hash-mismatch", "artifact-schema-invalid", "artifact-store-unavailable",
] as const)("tiers emitted %s health from a collected page", async (health) => {
  await writeProfileFile(env.dir, profile);
  const ref = `experiment-result/probe@sha256:${"a".repeat(64)}`;
  await writeMarkdownPage(env.dir, "wiki/experiments", "exp", `---\ntitle: E\nstage: running\nresult: ${ref}\n---\nBody.\n`);
  vi.spyOn(artifacts, "resolveArtifactRef").mockResolvedValue({ health });
  const { summary, tiered } = await lintBothViews(env.dir);
  const found = summary.results.filter((r) => r.rule === health);
  expect(found).toHaveLength(1);
  expect(tiered.deterministic).toContain(found[0]);
  expect(tiered.providerJudgement).toEqual([]);
});
