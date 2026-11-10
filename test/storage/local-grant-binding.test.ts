/**
 * @file test/storage/local-grant-binding.test.ts
 * @description The local workflow-authority grant as ONE body over the shared
 * project config leaf, `loadLocalGrantFrom`, with no project directory: absence
 * means the surface cap, a valid grant tightens, and every read or shape problem
 * fails closed to `read-only`. The root form `loadLocalGrant(root, surface)`
 * answers the same projects on real disk, and the shared leaf is shown reaching
 * the incumbent confined directory resolution and capped no-follow read.
 *
 * NOT SHOWN HERE: links, FIFOs, caps and escaping directories themselves; the
 * confined-read, private-dir and `workflow-local-config` suites show those.
 */

import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { SURFACE_HARD_CAP } from "../../src/local-workflow-host/authority.js";
import { loadLocalGrant, loadLocalGrantFrom } from "../../src/local-workflow-host/local-config.js";
import type { ActionSurface } from "../../src/profile/types.js";
import { MAX_LOCAL_CONFIG_BYTES } from "../../src/utils/constants.js";
import * as confinedRead from "../../src/utils/confined-read.js";
import * as privateDir from "../../src/utils/private-dir.js";
import { diskProjectConfigLeaf, type ProjectConfigLeafRead } from "../../src/utils/project-config-leaf.js";
import { tempRootTracker } from "../temp-roots.js";
import { writeFiles } from "./copied-project.js";
import { answerConfigProjects, projectConfigLeafOf as leafOf, PROJECT_CONFIG as CONFIG, type ConfigProjectFiles } from "./project-config-projects.js";

const PREFIX = "local-grant-binding-";
const SURFACES: ActionSurface[] = ["cli", "mcp"];
const tracker = tempRootTracker();
afterAll(() => tracker.cleanup());
afterEach(() => { vi.restoreAllMocks(); });

/** Projects by name: their files (`null` = no `.llmwiki` at all). */
const PROJECTS: Record<string, ConfigProjectFiles> = {
  "no private dir": null,
  "no config": { ".llmwiki/profile.json": "{}" },
  "review policy only": { [CONFIG]: JSON.stringify({ review: {} }) },
  "cli tightened": { [CONFIG]: JSON.stringify({ workflowGrants: { cli: "read-only" } }) },
  "unknown class": { [CONFIG]: JSON.stringify({ workflowGrants: { cli: "root-everything" } }) },
  corrupt: { [CONFIG]: "{not json" },
  "not an object": { [CONFIG]: "[]" },
};

describe("the local grant over the shared project config leaf", () => {
  it("G1 answers every project and surface exactly as the root form does on disk", async () => {
    const { onDisk, inMemory } = await answerConfigProjects(tracker, PREFIX, PROJECTS, {
      onDisk: (root) => Promise.all(SURFACES.map((surface) => loadLocalGrant(root, surface))),
      inMemory: (leaf) => Promise.all(SURFACES.map((surface) => loadLocalGrantFrom(leaf, surface))),
    });
    expect(inMemory).toEqual(onDisk);
    // The case only witnesses each rule when the disk applied it.
    const cap = SURFACES.map((surface) => SURFACE_HARD_CAP[surface]);
    expect(onDisk).toEqual({
      "no private dir": cap, "no config": cap, "review policy only": cap, "cli tightened": ["read-only", cap[1]],
      "unknown class": ["read-only", cap[1]], corrupt: ["read-only", "read-only"], "not an object": ["read-only", "read-only"],
    });
  });

  it("G2 a directory fault and an unreadable leaf fail closed; no directory and no leaf mean the cap", async () => {
    const grant = (read: ProjectConfigLeafRead) => loadLocalGrantFrom({ readConfig: async () => read }, "cli");
    expect(await Promise.all([grant({ kind: "dir-unavailable" }), grant({ kind: "unavailable" }), grant({ kind: "dir-absent" }), grant({ kind: "absent" })]))
      .toEqual(["read-only", "read-only", SURFACE_HARD_CAP.cli, SURFACE_HARD_CAP.cli]);
  });

  it("G3 the bound route reaches neither mechanism, while the shared leaf reaches both with the root and the leaf path", async () => {
    const resolve = vi.spyOn(privateDir, "resolveExistingConfinedPrivateDir");
    const read = vi.spyOn(confinedRead, "readCappedNoFollow");
    await loadLocalGrantFrom(leafOf(PROJECTS["cli tightened"]!), "cli");
    expect([resolve.mock.calls.length, read.mock.calls.length]).toEqual([0, 0]);
    const root = await tracker.create(PREFIX);
    await writeFiles(root, PROJECTS["cli tightened"]!);
    expect(await loadLocalGrant(root, "cli")).toBe("read-only");
    const dir = await resolve.mock.results[0]!.value as string;
    expect([resolve.mock.calls, read.mock.calls]).toEqual([[[root]], [[path.join(dir, "config.json"), MAX_LOCAL_CONFIG_BYTES]]]);
    const outcome = await diskProjectConfigLeaf(root).readConfig();
    expect(outcome.kind).toBe("ok");
  });
});
