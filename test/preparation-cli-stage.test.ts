/**
 * @file test/preparation-cli-stage.test.ts
 * @description Task 10 slice — the WRITE half of the preparation CLI: genesis
 * through the terminal transition, and what the staged run actually records.
 *
 * Split from `preparation-cli.test.ts` at the 400-line limit. The read half
 * keeps `list` and the refusal taxonomy; this half owns `stage` and the
 * end-to-end lifecycle, which is where the durable-state assertions live.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import {
  emptyWorkspace, expectRefusal, initializedWorkspace, listedStates,
  planAndSeed, planWithoutSeed, stageable, stageManifest,
} from "./preparation-cli-fixture.js";

/** Corrupt the active configuration and require the precise readiness refusal. */
async function expectUnreadableProfile(cwd: string, planFile: string, seedFile: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  const { PROFILE_FILE } = await import("../src/utils/constants.js");
  await writeFile(path.join(cwd, PROFILE_FILE), "{ not json");
  const reason = await expectRefusal(["preparation", "stage", planFile, "--seed", seedFile], cwd);
  expect(reason).toMatch(/profile is present but unreadable/u);
}

describe("GENESIS TO TERMINAL, entirely through the binary", () => {
  it("stage -> list -> fail -> list, with no in-process substrate call", async () => {
    // THE SLICE'S CLAIM, finally true. Every earlier version of this test
    // staged through `lifecycle-fixture.ts`, i.e. called the substrate in
    // process — so the "end to end" path began at a fixture and only its
    // terminal half went through the CLI. `stagePreparationLocked` had zero
    // production callers, which is the same substitution the superseded stack
    // made everywhere.
    //
    // Nothing here touches `src/preparations` directly. The plan document is
    // written to disk exactly as an operator would, and every state assertion
    // is read back through a separate process invocation.
    const cwd = await initializedWorkspace("genesis");
    // `planAndSeed` uses `fixturePlan`, whose initial input set digest matches
    // the seed it writes. `validPlan`'s digest is something else, so staging
    // refuses on evidence coverage — the substrate doing its job, asserted
    // deliberately by the sibling refusal test.
    const { planFile, seedFile } = await planAndSeed(cwd);

    const staged = await runCLI(
      ["preparation", "stage", planFile, "--seed", seedFile, "--json"], cwd);
    expectCLIExit(staged, 0);
    const created = JSON.parse(staged.stdout) as { status: string; runId: string };
    expect(created.status).toBe("staged");

    expect((await listedStates(cwd))[created.runId]).toBe("planned");

    const failed = await runCLI(["preparation", "fail", created.runId], cwd);
    expectCLIExit(failed, 0);

    expect((await listedStates(cwd))[created.runId]).toBe("failed");
  });

  it("REFUSES an invalid plan document without creating a run", async () => {
    const cwd = await initializedWorkspace("badplan");
    const { writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const planFile = path.join(cwd, "plan.json");
    await writeFile(planFile, JSON.stringify({ schemaVersion: 1, nonsense: true }));

    const reason = await expectRefusal(["preparation", "stage", planFile], cwd);
    expect(reason).toMatch(/plan is invalid/u);
    // NOTHING was created — a refused stage must not leave a partial run.
    const listed = await runCLI(["preparation", "list", "--json"], cwd);
    expect((JSON.parse(listed.stdout) as { runs: unknown[] }).runs).toEqual([]);
  });

  it("REFUSES a plan whose declared input the operator did not supply", async () => {
    // The schema REQUIRES an initial input set, so this is the ordinary
    // operator mistake, not an edge case — and the refusal has to name the flag
    // they need rather than fail deeper on evidence coverage.
    const cwd = await initializedWorkspace("declaredinputs");
    const planFile = await planWithoutSeed(cwd);
    expect(await expectRefusal(["preparation", "stage", planFile], cwd)).toMatch(/pass --seed/u);
  });

  it("REFUSES an allowance that is not a positive whole number", async () => {
    // The one numeric the operator supplies. `Number("")` is 0 and
    // `Number("1e999")` is Infinity, so neither a bare truthiness check nor
    // `parseInt` would catch these.
    const cwd = await initializedWorkspace("allowance");
    const planFile = await planWithoutSeed(cwd);

    for (const bad of ["0", "-1", "1e999", "abc", "1.5"]) {
      const reason = await expectRefusal(["preparation", "stage", planFile, "--allowance", bad], cwd);
      expect(reason).toMatch(/positive whole number/u);
    }
  });
});

describe("stage respects the plan and the project lock", () => {
  it("carries the plan's DECLARED classification into the manifest", async () => {
    // The plan's `initialInputSet` declares kind, mediaType, provenanceLabel,
    // sensitivity and retention. Hardcoding a different set silently DOWNGRADED
    // a restricted/audit input to ordinary/until-handoff — and nothing caught
    // it, because the coverage check compares the DIGEST only and the digest is
    // over the value alone. Metadata never enters it, so only reading the
    // durable manifest can witness this.
    const { cwd, planFile, seedFile } = await stageable("classification", (object) => {
      const set = object.initialInputSet as Record<string, unknown>;
      set.sensitivity = "restricted";
      set.retention = "audit";
    });

    // THE RECORDED INPUT, not the manifest as a whole. The manifest embeds the
    // PLAN too, so a substring search finds the operator's declaration whether
    // or not the input inherited it — the assertion passed with the hardcoded
    // values still in place. `initialEvidence` is what the input actually got.
    const manifest = await stageManifest(cwd, planFile, seedFile) as {
      initialEvidence: { sensitivity: string; retention: string }[];
    };
    expect(manifest.initialEvidence).toHaveLength(1);
    expect(manifest.initialEvidence[0]!.sensitivity).toBe("restricted");
    expect(manifest.initialEvidence[0]!.retention).toBe("audit");
  });

  it("REFUSES to create a store as a side effect of staging", async () => {
    // A write verb run one directory deep silently minted a SECOND `.llmwiki`
    // — new key epoch, manifest, evidence, run — invisible to `list` from the
    // project root. The cwd-without-upward-discovery decision was made about a
    // READ verb, where the worst outcome is a wrong message.
    const cwd = await emptyWorkspace("nostore");
    const { access } = await import("node:fs/promises");
    const { planFile, seedFile } = await planAndSeed(cwd);

    const reason = await expectRefusal(["preparation", "stage", planFile, "--seed", seedFile], cwd);
    expect(reason).toMatch(/no \.llmwiki store/u);
    // NOTHING was created — the refusal must not leave a partial store behind.
    await expect(access(path.join(cwd, ".llmwiki"))).rejects.toThrow();
  });

  it("REFUSES a seed whose digest does not match, as a typed envelope", async () => {
    // The everyday operator mistake. It escaped as an internal validator string
    // naming neither the flag nor the file, with EMPTY stdout under `--json`.
    const cwd = await initializedWorkspace("wrongseed");
    const { writeFile } = await import("node:fs/promises");
    const { planFile, seedFile } = await planAndSeed(cwd);
    await writeFile(seedFile, JSON.stringify({ not: "the declared bytes" }));

    // Parseable, and on stdout — the envelope contract holds on the refusal
    // path too, which is where it was broken.
    const reason = await expectRefusal(["preparation", "stage", planFile, "--seed", seedFile], cwd);
    expect(reason).toMatch(/staging refused/u);
  });

  it("REFUSES to stage while the project lock is held", async () => {
    // `stagePreparationLocked` documents that its caller already holds the
    // lock. Calling it bare let concurrent stages race on the key epoch — the
    // trust root — and skipped the recovery gate entirely.
    const cwd = await initializedWorkspace("staglock");
    const { planFile, seedFile } = await planAndSeed(cwd);

    const { acquireMutationLock } = await import("../src/operation-bundles/lock-gate.js");
    const { releaseLock } = await import("../src/utils/lock.js");
    expect(await acquireMutationLock(cwd, "ordinary")).toBe(true);
    try {
      const reason = await expectRefusal(["preparation", "stage", planFile, "--seed", seedFile], cwd);
      expect(reason).toMatch(/lock is busy/u);
    } finally {
      await releaseLock(cwd);
    }
  });
});

describe("the host readiness precheck", () => {
  it("REFUSES when the project's own configuration is unreadable", async () => {
    // This is a READINESS check, not an authority boundary. It answers whether
    // the project can be acted in at all — a present-but-broken profile, or an
    // unreadable key — and says nothing about whether a plan's declared
    // authorities are ones this host recognises. Nothing here can answer that,
    // and the earlier version claimed otherwise.
    const cwd = await initializedWorkspace("readiness");
    const { planFile, seedFile } = await planAndSeed(cwd);
    await expectUnreadableProfile(cwd, planFile, seedFile);
  });

  it("does NOT claim to authorize a plan's declared authorities", async () => {
    // Deliberate and asserted, so the limit cannot be quietly forgotten: two
    // plans naming entirely different knowledge authorities are BOTH accepted,
    // because no host policy or registry exists to compare them against. This
    // slice is local-operator-only. When a host authority boundary exists it needs
    // its own change, with a durable binding and a decision this can actually
    // refuse on.
    const { resolveHostReadiness } = await import("../src/commands/preparation/host.js");
    const cwd = await initializedWorkspace("noauthorityclaim");
    await planAndSeed(cwd);
    const ready = await resolveHostReadiness(cwd);
    expect(ready.ready).toBe(true);
    // The readiness result carries NO admission digest and no plan-derived
    // field — presenting one as an enforced boundary is the claim that was
    // withdrawn.
    expect(Object.keys(ready).sort()).toEqual(["ready", "reason"]);
  });
});

describe("what the staged run actually records", () => {
  it("carries the OPERATOR's allowance, not the default", async () => {
    // The allowance was pinned only for REJECTING bad values; nothing observed
    // that a good one reaches the request. Substituting the default for the
    // operator's value passed the entire suite.
    // Asserted DIRECTLY on the genesis transition, which is where the run
    // contract records it. My first version compared two runs staged with
    // different allowances and asserted they differed — which passed even with
    // the operator's value discarded, because each project has its own random
    // key epoch so the records differ regardless. A difference test whose
    // subject is not the only thing that differs proves nothing.
    const { cwd, planFile, seedFile } = await stageable("carriesallowance");
    const staged = await runCLI(
      ["preparation", "stage", planFile, "--seed", seedFile, "--allowance", "24", "--json"], cwd);
    expectCLIExit(staged, 0);
    const created = JSON.parse(staged.stdout) as { runId: string; workspaceId: string };
    const { readdir, readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = path.join(cwd, ".llmwiki", "workspaces", created.workspaceId, "preparation-runs");
    const [leaf] = await readdir(dir);
    const run = JSON.parse(await readFile(path.join(dir, leaf!), "utf8")) as {
      controlTransitionAllowance?: number;
    };
    expect(run.controlTransitionAllowance).toBe(24);
  });

  it("records the CLI operator as the actor, not an arbitrary identity", async () => {
    // Forging the actor to a made-up id passed the entire suite: nothing
    // observed whose identity lands on the durable record.
    const { cwd, planFile, seedFile } = await stageable("actor");
    const manifest = await stageManifest(cwd, planFile, seedFile);
    expect(manifest.createdBy).toMatchObject({ id: "cli-operator", surface: "cli" });
  });

  it("records the OPERATOR's seed bytes, not a constant", async () => {
    // Replacing the parsed seed with a hardcoded constant passed the suite,
    // because the fixture's seed IS that constant. A different-but-valid seed
    // is the only way to tell them apart — it changes the digest, so the plan's
    // declared input set has to match it.
    const cwd = await initializedWorkspace("seedbytes");
    const { fixturePlan } = await import("./preparations/store-fixture.js");
    const { canonicalBytes } = await import("../src/profile/templates/signing/canonical.js");
    const { createHash } = await import("node:crypto");
    const { writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const value = { seed: "a-different-seed", version: 7 };
    const digest = createHash("sha256").update(canonicalBytes(value)).digest("hex");
    const plan = fixturePlan((object) => {
      const set = object.initialInputSet as Record<string, unknown>;
      set.digest = `sha256:${digest}`;
      set.byteCount = canonicalBytes(value).byteLength;
    });
    const planFile = path.join(cwd, "plan.json");
    const seedFile = path.join(cwd, "seed.json");
    await writeFile(planFile, JSON.stringify(plan));
    await writeFile(seedFile, JSON.stringify(value));

    const staged = await runCLI(
      ["preparation", "stage", planFile, "--seed", seedFile, "--json"], cwd);
    // Staging SUCCEEDS only if the recorded evidence hashes to this seed — a
    // constant would produce a different digest and be refused.
    expectCLIExit(staged, 0);
  });

  it("REFUSES to stage when the project's configuration is unreadable", async () => {
    // `fail` has this control; `stage` — the genesis command — had none, and
    // deleting its authority gate passed the whole suite.
    const { cwd, planFile, seedFile } = await stageable("stageauthority");
    await expectUnreadableProfile(cwd, planFile, seedFile);
  });
});

describe("a fault is not a refusal", () => {
  it("an I/O failure during publication stays VISIBLE, not reported as refused", async () => {
    // The substrate publishes evidence, then the manifest, then the run. A
    // failure after the first two means durable state HAS changed — so
    // reporting `refused`, which tells an operator nothing happened, is worse
    // than crashing. Catching every `Error` did exactly that.
    //
    // The workspaces tree is made unwritable AFTER the key is minted, so the
    // failure lands inside publication rather than at the first read.
    const cwd = await initializedWorkspace("faultnotrefusal");
    const { planFile, seedFile } = await planAndSeed(cwd);
    const first = await runCLI(
      ["preparation", "stage", planFile, "--seed", seedFile, "--json"], cwd);
    expectCLIExit(first, 0);

    const { chmod } = await import("node:fs/promises");
    const { PREPARATIONS_SEGMENT } = await import("../src/preparations/paths.js");
    const created = JSON.parse(first.stdout) as { workspaceId: string };
    // The directory staging actually writes into. Locking the tree ABOVE it
    // left the write path intact and the second stage simply succeeded — a
    // fault fixture that never produced a fault.
    const workspaces = path.join(
      cwd, ".llmwiki", "workspaces", created.workspaceId, PREPARATIONS_SEGMENT);
    await chmod(workspaces, 0o500);
    try {
      const result = await runCLI(
        ["preparation", "stage", planFile, "--seed", seedFile, "--json"], cwd);
      expect(result.code).not.toBe(0);
      // A FAULT: it must not arrive dressed as an ordinary business refusal.
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).not.toMatch(/"status":\s*"refused"/u);
      expect(combined).toMatch(/EACCES|EPERM/u);
    } finally {
      await chmod(workspaces, 0o700);
    }
  });
});
