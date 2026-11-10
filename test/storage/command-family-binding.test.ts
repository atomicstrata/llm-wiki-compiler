/**
 * @file test/storage/command-family-binding.test.ts
 * @description The `rm`, `visualize` and `schema init` commands as ONE body each
 * over their project steps (`rmCommandWith`, `visualizeCommandWith`,
 * `schemaInitCommandWith`), with no project directory: each command's own
 * sequencing, refusals, transcript order, lock discipline and exit code. Each
 * root form is shown reaching its incumbents with the working directory (or the
 * given root) first, the incumbents stubbed so no project is written.
 *
 * NOT SHOWN HERE: the removal planner and applier, the snapshot, the artifact
 * writers and the schema loader themselves; their suites and the command suites
 * (`rm-integration`, `visualize`, `schema`) show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { rmCommand, rmCommandWith, type RmSteps } from "../../src/commands/rm.js";
import { schemaInitCommand, schemaInitCommandWith, type SchemaInitSteps } from "../../src/commands/schema.js";
import visualizeCommand, { visualizeCommandWith, type VisualizeSteps } from "../../src/commands/visualize.js";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import * as registeredLock from "../../src/operation-bundles/registered-project-lock.js";
import * as profileLoad from "../../src/profile/load.js";
import * as removal from "../../src/sources/removal.js";
import type { RemovalApplyResult, RemovalPlan } from "../../src/sources/removal.js";
import * as diskLocations from "../../src/storage/disk-locations.js";
import * as lock from "../../src/utils/lock.js";
import * as output from "../../src/utils/output.js";
import * as navigationWrite from "../../src/viewer/navigation-write.js";
import * as snapshot from "../../src/viewer/snapshot.js";
import { captureStatusLines } from "./project-tree.js";

const PLAN = {
  sourceFile: "a.md", sourcePresent: true, deleteSlugs: ["alpha"], keptSlugs: [], brokenLinks: [], candidateRefs: [], profileId: null,
} as unknown as RemovalPlan;
const APPLIED: RemovalApplyResult = { deleted: ["alpha"], skipped: [], sourceDeleted: true };

/** Every status line and every step, in one order. */
function transcript(): string[] {
  const log: string[] = [];
  captureStatusLines(log);
  vi.spyOn(output, "note").mockImplementation(() => {});
  vi.spyOn(output, "header").mockImplementation(() => {});
  return log;
}
afterEach(() => { vi.restoreAllMocks(); });

/** Scripted removal steps logging into `log`. */
function rmSteps(log: string[], answers: { plan?: RemovalPlan | null; locked?: boolean; applied?: RemovalApplyResult; regenFault?: Error } = {}): RmSteps {
  return {
    plan: async (ref) => { log.push(`plan ${ref}`); return answers.plan === undefined ? PLAN : answers.plan; },
    acquireLock: async () => { log.push("lock"); return answers.locked ?? true; },
    apply: async () => { log.push("apply"); return answers.applied ?? APPLIED; },
    regenerate: async () => { log.push("regenerate"); if (answers.regenFault) throw answers.regenFault; },
    releaseLock: async () => { log.push("release"); },
  };
}

describe("rm over its steps", () => {
  it("R1 refuses an unmatched ref, and a dry run prints without taking the lock", async () => {
    const log = transcript();
    expect(await rmCommandWith(rmSteps(log, { plan: null }), "nope")).toBe(1);
    expect(log).toEqual(["plan nope", 'x No source matches "nope". Look in sources/ for the filename.']);
    log.length = 0;
    expect(await rmCommandWith(rmSteps(log), "a", { dryRun: true })).toBe(0);
    expect(log.filter((line) => ["lock", "apply"].includes(line))).toEqual([]);
  });

  it("R2 refuses a held lock, and otherwise reports what it applied BEFORE regenerating, releasing in the end", async () => {
    const log = transcript();
    expect(await rmCommandWith(rmSteps(log, { locked: false }), "a")).toBe(1);
    expect(log.at(-1)).toBe("x Another llmwiki process holds the project lock. Try again when it finishes.");
    log.length = 0;
    expect(await rmCommandWith(rmSteps(log), "a")).toBe(0);
    const at = (line: string) => log.indexOf(line);
    expect([at("plan a") < at("lock"), at("apply") < at("regenerate"), at("regenerate") < at("release")]).toEqual([true, true, true]);
    expect(log.slice(at("apply") + 1, at("regenerate")).length).toBeGreaterThan(0);
  });

  it("R3 a skipped page makes the exit code 1, and a regeneration fault still releases the lock", async () => {
    const log = transcript();
    const skipped: RemovalApplyResult = { ...APPLIED, skipped: [{ slug: "beta", reason: "unsafe" } as never] };
    expect(await rmCommandWith(rmSteps(log, { applied: skipped }), "a")).toBe(1);
    log.length = 0;
    await expect(rmCommandWith(rmSteps(log, { regenFault: new Error("strict embeddings") }), "a")).rejects.toThrow("strict embeddings");
    expect(log.at(-1)).toBe("release");
  });
});

describe("visualize and schema init over their steps", () => {
  const steps = (log: string[], nodes: never[]): VisualizeSteps => ({
    snapshot: async () => { log.push("snapshot"); return { graph: { nodes, edges: [] } } as never; },
    loadProfile: async () => { log.push("profile"); return { profile: { entities: { papers: {} } }, loadedFrom: "/p" } as never; },
    writeArtifact: async (relativePath) => { log.push(`write ${relativePath}`); return { file: relativePath, outcome: "created" }; },
  });

  it("V1 refuses an unknown focus before reading the profile, and otherwise writes the graph config then the canvas", async () => {
    const log = transcript();
    expect(await visualizeCommandWith(steps(log, []), { focus: "papers/x" })).toBe(1);
    expect(log.filter((line) => !line.includes(" "))).toEqual(["snapshot"]);
    log.length = 0;
    expect(await visualizeCommandWith(steps(log, []))).toBe(0);
    expect(log.filter((line) => !line.startsWith("✓") && !line.startsWith("i "))).toEqual([
      "snapshot", "profile", "write wiki/.obsidian/graph.json", "write wiki/canvases/knowledge-map.canvas",
    ]);
  });

  it("S1 schema init refuses an existing schema without writing, and otherwise creates the directory then writes, all under the gate", async () => {
    const run = async (exists: boolean) => {
      const log = transcript();
      const init: SchemaInitSteps = {
        underProjectGate: async (write) => { log.push("gate"); await write(); log.push("ungate"); },
        targetPath: () => "/p/.llmwiki/schema.json", targetExists: () => exists,
        ensureTargetDirectory: async () => { log.push("mkdir"); }, writeTarget: async (text) => { log.push(`write ${JSON.parse(text).version}`); },
      };
      await schemaInitCommandWith(init);
      return log;
    };
    expect(await run(true)).toEqual(["gate", "! Schema file already exists at /p/.llmwiki/schema.json", "ungate"]);
    const fresh = await run(false);
    expect([fresh[0], fresh[1], fresh[2]?.startsWith("write "), fresh[3], fresh[4]]).toEqual(["gate", "mkdir", true, "+ Wrote schema to /p/.llmwiki/schema.json", "ungate"]);
  });
});

describe("the root forms reach their incumbents", () => {
  it("Z1 rm, visualize and schema init reach each incumbent with the working directory or given root first", async () => {
    transcript();
    vi.spyOn(process, "cwd").mockReturnValue("/project");
    const plan = vi.spyOn(removal, "planRemoval").mockResolvedValue(PLAN);
    const acquire = vi.spyOn(lockGate, "acquireMutationLock").mockResolvedValue(true);
    const apply = vi.spyOn(removal, "applyRemovalLocked").mockResolvedValue(APPLIED);
    const regenerate = vi.spyOn(removal, "regenerateDerivedLocked").mockResolvedValue(undefined);
    const release = vi.spyOn(lock, "releaseLock").mockResolvedValue(undefined);
    expect(await rmCommand("a")).toBe(0);
    expect([plan.mock.calls, acquire.mock.calls, apply.mock.calls, regenerate.mock.calls, release.mock.calls])
      .toEqual([[["/project", "a"]], [["/project", "ordinary"]], [["/project", PLAN]], [["/project"]], [["/project"]]]);
    const snap = vi.spyOn(snapshot, "buildViewerSnapshot").mockResolvedValue({ graph: { nodes: [], edges: [] } } as never);
    const profile = vi.spyOn(profileLoad, "loadProfile").mockResolvedValue({ profile: {}, loadedFrom: null } as never);
    const write = vi.spyOn(navigationWrite, "writeDerivedArtifact").mockResolvedValue({ file: "x", outcome: "created" });
    expect(await visualizeCommand("/root")).toBe(0);
    expect([snap.mock.calls, profile.mock.calls, write.mock.calls.map((call) => call.slice(0, 2))])
      .toEqual([[["/root"]], [["/root"]], [["/root", "wiki/.obsidian/graph.json"], ["/root", "wiki/canvases/knowledge-map.canvas"]]]);
    const gate = vi.spyOn(registeredLock, "withRegisteredProjectLock").mockImplementation(async (_root, write) => write());
    const exists = vi.spyOn(diskLocations, "locationExistsSync").mockReturnValue(true);
    await schemaInitCommand();
    expect([gate.mock.calls[0]?.[0], exists.mock.calls.length]).toEqual(["/project", 1]);
  });
});
