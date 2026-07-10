/**
 * @file test/fixtures/seam-fixtures.ts
 * @description Shared NON-DEFAULT fixture for the relation/lifecycle executor-kind
 * seam tests. One profile exercises BOTH kinds: a `papers` entity carrying a
 * `draft → review → published` lifecycle FSM on a `lifecycle` field, plus a
 * declared `cites` relation (papers → papers). The builder seeds the requested
 * `papers/<slug>` pages in `draft`. Centralized so the integration and
 * audit-residual suites declare ONE shape and vary only the assertion under test.
 */

import { writeFile, readFile, mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect } from "vitest";
import type { EntityId, ProfilePack } from "../../src/profile/types.js";
import type { StageOutput } from "../../src/workflows/stage-output.js";
import { parseFrontmatter } from "../../src/utils/markdown.js";
import { readEvents } from "../../src/events/store-read.js";
import { startWorkflow } from "../../src/workflows/start.js";
import { readRun } from "../../src/workflows/store.js";
import { PROFILE_FILE } from "../../src/utils/constants.js";
import { buildResearchLiteProject } from "./profile-fixtures.js";

/** A non-default profile with a `papers` lifecycle FSM + a `cites` relation. */
export function seamProfile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research-seam",
    entities: {
      papers: {
        directory: "wiki/papers",
        requiredFields: ["lifecycle"],
        fields: { lifecycle: { type: "enum", enum: ["draft", "review", "published"] } },
        lifecycle: {
          field: "lifecycle",
          initial: "draft",
          terminal: ["published"],
          transitions: { draft: ["review"], review: ["published"] },
        },
      },
    },
    relations: { cites: { from: ["papers"], to: ["papers"], direction: "directed" } },
  } as ProfilePack;
}

/**
 * Materialize a seam project at `root`: the {@link seamProfile} on disk plus the
 * requested `papers/<slug>` pages, each in the initial `draft` state.
 *
 * @param root - Absolute project root directory.
 * @param slugs - The `papers/<slug>` pages to seed (default `["a", "b"]`).
 */
export async function buildSeamProject(root: string, slugs: string[] = ["a", "b"]): Promise<void> {
  await buildPapersLifecycleProject(root, seamProfile(), slugs);
}

/**
 * A `papers` lifecycle whose `review` transition REQUIRES a `reviewer` field, so a
 * legal `draft → review` accepts exactly one evidence key — any other caller key is
 * junk the allow-list drops. Shared by the audit-payload + frontmatter-preservation
 * suites so they declare ONE requirement-gated shape.
 */
export function reviewerLifecycleProfile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research-reviewer",
    entities: {
      papers: {
        directory: "wiki/papers",
        requiredFields: ["lifecycle"],
        fields: {
          lifecycle: { type: "enum", enum: ["draft", "review", "published"] },
          reviewer: { type: "string" },
        },
        lifecycle: {
          field: "lifecycle",
          initial: "draft",
          terminal: ["published"],
          transitions: { draft: ["review"], review: ["published"] },
          transitionRequirements: { review: ["reviewer"] },
        },
      },
    },
  } as ProfilePack;
}

/**
 * Materialize a `papers` lifecycle project at `root` from an ARBITRARY profile
 * (so a test can vary the FSM / transition requirements), seeding the requested
 * `papers/<slug>` pages each in the initial `draft` state. The profile-agnostic
 * sibling of {@link buildSeamProject}.
 *
 * @param root - Absolute project root directory.
 * @param profile - The non-default profile to write to disk.
 * @param slugs - The `papers/<slug>` pages to seed (default `["a"]`).
 */
export async function buildPapersLifecycleProject(
  root: string,
  profile: ProfilePack,
  slugs: string[] = ["a"],
): Promise<void> {
  await buildResearchLiteProject(root);
  await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(profile), "utf8");
  await mkdir(path.join(root, "wiki/papers"), { recursive: true });
  for (const slug of slugs) {
    await writeFile(path.join(root, `wiki/papers/${slug}.md`), "---\nlifecycle: draft\n---\n\nBody.\n", "utf8");
  }
}

/**
 * A `papers` lifecycle FSM + a `cites` relation + a one-stage `build` workflow whose
 * stage declares `stageWrites` and (optionally) a `gate`. Shared by the relation/
 * lifecycle KIND seam tests AND the auto-fail-on-hard-denial tests so the `profileId`
 * ("research-kinds") + FSM shape are declared in ONE place.
 *
 * @param stageWrites - The stage's declared `writes` set (in/out-of-scope control).
 * @param gate - An optional stage gate (e.g. `"trust:high"`).
 * @returns The non-default profile pack.
 */
export function kindsProfile(stageWrites: string[], gate?: string): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research-kinds",
    entities: {
      papers: {
        directory: "wiki/papers",
        requiredFields: ["lifecycle"],
        fields: { lifecycle: { type: "enum", enum: ["draft", "review", "published"] } },
        lifecycle: { field: "lifecycle", initial: "draft", terminal: ["published"], transitions: { draft: ["review"], review: ["published"] } },
      },
      // declared so a stage may scope its `writes` to `experiments` (out of scope
      // for a papers relation/lifecycle) without tripping profile validation.
      experiments: { directory: "wiki/experiments" },
    },
    relations: { cites: { from: ["papers"], to: ["papers"], direction: "directed" } },
    workflows: { build: { stages: [{ id: "run", reads: ["papers"], writes: stageWrites, ...(gate ? { gate } : {}) }] } },
  } as ProfilePack;
}

/**
 * Stand up a kinds project (`profile` on disk + `papers/<slug>` draft pages) in a
 * fresh temp root and start a `build` run. Shared so the kinds + auto-fail suites
 * don't each re-declare the mkdtemp→seed→start preamble.
 *
 * @param prefix - The mkdtemp prefix for the per-test root.
 * @param profile - The kinds profile to install (see {@link kindsProfile}).
 * @param slugs - The `papers/<slug>` pages to seed (default `["a", "b"]`).
 * @returns The temp root and the started run's id.
 */
export async function startKindsRun(prefix: string, profile: ProfilePack, slugs: string[] = ["a", "b"]): Promise<{ root: string; runId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await buildPapersLifecycleProject(root, profile, slugs);
  const run = await startWorkflow(root, "build", {});
  return { root, runId: run.runId };
}

/** A `cites` relation output between `papers/a` and `papers/b` (both in scope). */
export function citesOutput(): StageOutput {
  return { kind: "relation", input: { type: "cites", from: "papers/a" as EntityId, to: "papers/b" as EntityId, attributes: {} } };
}

/**
 * Assert a run is now terminal `failed` AND its trust gate was NOT satisfied — the
 * shared post-condition of a HARD-denied submit (BUG 1 auto-fail routing), reused so
 * each denial test does not re-spell the read-back + dual assertion.
 *
 * @param root - The project root whose run record is read back.
 * @param runId - The run id to assert on.
 */
export async function expectRunFailedNoGate(root: string, runId: string): Promise<void> {
  const read = await readRun(root, runId);
  expect(read.status === "ok" && read.run.status).toBe("failed");
  expect(read.status === "ok" && read.run.satisfiedGates).not.toContain("trust:high");
}

/** Parsed lifecycle frontmatter value for `papers/<slug>` on disk. */
export async function pageLifecycle(root: string, slug: string): Promise<unknown> {
  const raw = await readFile(path.join(root, `wiki/papers/${slug}.md`), "utf8");
  return parseFrontmatter(raw).meta.lifecycle;
}

/**
 * Assert the LAST audit event is a `lifecycle-transition` carrying a TOP-LEVEL
 * `decision` of the given value (relation/lifecycle events record the recomposed
 * trust decision top-level, mirroring relation events).
 *
 * @param root - Project root whose event store is read back.
 * @param decision - The expected top-level decision (e.g. `"allow"`).
 */
export async function expectLifecycleEventDecision(root: string, decision: string): Promise<void> {
  const ev = (await readEvents(root)).events.at(-1) as { type?: string; decision?: string } | undefined;
  expect(ev?.type).toBe("lifecycle-transition");
  expect(ev?.decision).toBe(decision);
}
