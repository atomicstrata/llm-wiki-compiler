/**
 * @file test/preparations/ephemeral-fixture.ts
 * @description Shared harness for the executable ephemeral-read suites. It builds
 * ephemeral-read plans (provider and host-handler executors) from the shared plan
 * fixture, ephemeral read requests over the same fake host-owned authority
 * resolver the durable attempt suites use, and a SANDBOX that redirects `TMPDIR`,
 * the XDG operator/cache roots, and `HOME` into one private directory — so a
 * single `residue` assertion proves the read left no temporary custody, operator,
 * cache, or home byte anywhere outside the project it never touches.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parsePreparationPlan } from "../../src/preparations/plan-parse.js";
import type { NormalizedPreparationPlanV1 } from "../../src/preparations/plan-types.js";
import {
  runEphemeralRead, runEphemeralReadWithInvoke,
  type EphemeralReadRequestV1, type EphemeralReadResultV1,
} from "../../src/preparations/ephemeral-execute.js";
import type { ProviderInvokeFn } from "../../src/preparations/attempts/provider.js";
import type { ProviderInvocationHostV1 } from "../../src/capability-providers/runtime/invoke.js";
import { fixedResolver, PIN, providerRequest, providerAuthority } from "./attempt-fixture.js";
import { ephemeralPlanObject, ephemeralBrokerPlan } from "./inputs-fixture.js";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";

/** The opaque provider host; the fake invoke seam never reads it. */
export const HOST = {} as ProviderInvocationHostV1;

/** Bind a broker-enabled read to the matching sealed plan and live authority. */
export function ephemeralBrokerRequest(broker: "https" | "model") {
  const brokerPlanDigest = parseSha256Digest(`sha256:${"c".repeat(64)}`);
  return ephemeralRequest({
    plan: ephemeralBrokerPlan(),
    authorityResolver: { resolve: async () => ({ status: "ok", extras: providerAuthority({ brokerPlanDigest }) }) },
    work: { kind: "provider-capability", request: providerRequest({ brokers: { [broker]: {} } }), host: HOST },
  });
}

/** The env names the sandbox redirects so every out-of-project write is visible. */
const SANDBOXED_ENV = ["TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "HOME"] as const;

/** A strictly increasing ISO clock so each minted timestamp is distinct. */
function ephemeralClock(): { now(): string } {
  let tick = 0;
  return { now: () => new Date(Date.UTC(2026, 6, 23) + tick++ * 1000).toISOString() };
}

/** Build one ephemeral-read plan whose single `collect` phase is provider-driven. */
export function ephemeralProviderPlan(
  mutatePhase: (phase: Record<string, unknown>) => void = () => {},
  boundsOverride: Record<string, number> = {},
): NormalizedPreparationPlanV1 {
  return parsePreparationPlan(JSON.stringify(ephemeralPlanObject(mutatePhase, boundsOverride)));
}

/** The declared worst-case envelope of the two-phase ephemeral plan below. */
const TWO_PHASE_BOUNDS = {
  maximumPhaseInstances: 2, maximumAttempts: 4, maximumInvocations: 4, maximumTransitions: 8,
  maximumEvidenceRefs: 6, maximumEvidenceBytes: 2048, maximumTokens: 400, maximumTimeMs: 2000,
  maximumCostMicros: 40,
};

/**
 * Build a two-phase ephemeral-read plan whose ONLY declared producer, `second`,
 * depends on `collect`. Neither phase may run as an ephemeral read: `collect`
 * produces no declared output, and `second`'s dependency would never have run.
 */
export function ephemeralTwoPhasePlan(): NormalizedPreparationPlanV1 {
  const object = ephemeralPlanObject(() => {}, TWO_PHASE_BOUNDS);
  const collect = (object.phases as Record<string, unknown>[])[0]!;
  object.phases = [collect, {
    ...collect, logicalPhaseId: "second", dependsOn: ["collect"],
    inputBindings: [{ bindingId: "collected", sourceKind: "phase-output", sourcePhaseId: "collect" }],
  }];
  object.outputContract = { producingPhaseIds: ["second"] };
  return parsePreparationPlan(JSON.stringify(object));
}

/** Build one ephemeral-read plan whose single phase is host-handler-driven. */
export function ephemeralHostHandlerPlan(): NormalizedPreparationPlanV1 {
  return ephemeralProviderPlan((phase) => {
    phase.executor = {
      kind: "host-handler", handlerId: "expander", handlerContractVersion: "1", handlerContractDigest: PIN,
    };
  });
}

/** Build one ephemeral read request over the provider work seam. */
export function ephemeralRequest(
  overrides: Partial<EphemeralReadRequestV1> = {},
): EphemeralReadRequestV1 {
  return {
    plan: ephemeralProviderPlan(), logicalPhaseId: "collect", authorityResolver: fixedResolver(),
    work: { kind: "provider-capability", request: providerRequest(), host: HOST },
    clock: ephemeralClock(), ...overrides,
  };
}

/**
 * Run one ephemeral read, driving the HOST-SIDE test seam when a fake provider
 * runtime is supplied. `invoke` is deliberately a parameter and not a request
 * field: production callers cannot select the runtime from request data.
 */
export function runFixtureRead(
  request: EphemeralReadRequestV1, invoke?: ProviderInvokeFn,
): Promise<EphemeralReadResultV1> {
  return invoke === undefined
    ? runEphemeralRead(request) : runEphemeralReadWithInvoke(request, invoke);
}

/** The outcome of one sandboxed run: the callback result and the private residue. */
export interface SandboxRunV1<T> {
  readonly result: T;
  /** Every entry left behind under the private temporary/operator/cache/home root. */
  readonly residue: readonly string[];
}

/** Point one sandboxed env name at the private root, remembering the prior value. */
function redirectEnv(dir: string): Map<string, string | undefined> {
  const saved = new Map<string, string | undefined>();
  for (const name of SANDBOXED_ENV) {
    saved.set(name, process.env[name]);
    process.env[name] = name === "TMPDIR" ? dir : path.join(dir, name.toLowerCase());
  }
  return saved;
}

/** Restore every redirected env name to exactly its prior presence and value. */
function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/**
 * Run `fn` with `TMPDIR`, both XDG roots, and `HOME` redirected into one fresh
 * private directory, then report every entry left under it. An empty residue
 * proves the read created no temporary custody, operator, cache, or home byte —
 * and that any custody it DID create while running was discarded.
 */
export async function withEphemeralSandbox<T>(fn: () => Promise<T>): Promise<SandboxRunV1<T>> {
  const dir = await mkdtemp(path.join(tmpdir(), "ephemeral-sandbox-"));
  const saved = redirectEnv(dir);
  try {
    const result = await fn();
    return { result, residue: await readdir(dir) };
  } finally {
    restoreEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
}
