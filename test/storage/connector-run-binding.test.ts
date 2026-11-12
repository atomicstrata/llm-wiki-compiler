/**
 * @file test/storage/connector-run-binding.test.ts
 * @description A whole connector run as ONE body over `ConnectorRunSteps`
 * (`runConnectorWith`), none of which takes a project root, against the root
 * form `runConnector`.
 *
 * HOW IT IS BUILT. The compiled-in fixture connector and the newsroom profile
 * that binds it are used as they ship; the activation env var is stubbed. Memory
 * steps that log every call answer the profile, the config, the supersedable
 * selection, the audit preflight, the rate interval, the lock and the locked
 * stage, and a memory fetcher logs the request it is handed. They pin the whole
 * order (every gate before the fetch, the interval spent before it, the lock
 * taken only after it), each gate's refusal stopping the run where it stands,
 * the prepared draft handed to the stage, the lock released on every exit after
 * it was taken, and the public result check. The root form is shown handing each
 * incumbent the root and its old arguments.
 *
 * NOT SHOWN HERE: the config, selection, audit, rate and staging bodies
 * themselves; their binding suites (`connector-config-binding`,
 * `connector-supersession-binding`, `connector-rate-binding`,
 * `connector-stage-draft-binding`) and the connector suites show those.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";
import * as audit from "../../src/connectors/audit.js";
import { captureConnectorIdentity, preflightCandidateId } from "../../src/connectors/candidate-identity.js";
import * as supersession from "../../src/connectors/candidate-supersession.js";
import * as config from "../../src/connectors/config.js";
import type { ConfinedFetchResult } from "../../src/connectors/confined-fetch.js";
import { fixtureConnector } from "../../src/connectors/impl/fixture.js";
import * as rateLimit from "../../src/connectors/rate-limit.js";
import { runConnector, runConnectorWith, type ConnectorRunSteps, type RunConnectorDeps, type RunConnectorResult } from "../../src/connectors/run.js";
import * as stageDraft from "../../src/connectors/stage-draft.js";
import type { PreparedDraft } from "../../src/connectors/stage-draft.js";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import * as profileBlock from "../../src/profile/block.js";
import * as lock from "../../src/utils/lock.js";
import { NEWSROOM_PROFILE } from "../fixtures/newsroom-profile.js";

beforeEach(() => { stubEnv("LLMWIKI_CONNECTORS", "fixture"); });
afterEach(() => { vi.restoreAllMocks(); restoreEnv(); });

const ROOT = "/memory/project";
const INPUTS = { id: "story-1" };
const IDENTITY = captureConnectorIdentity(fixtureConnector, INPUTS)!;
const NOW = new Date("2026-10-14T00:00:00.000Z");
const CONFIG = { allowedHosts: ["fixture.local"], contactEmail: "ops@example.com", minRequestIntervalMs: 0 };
const FETCHED: ConfinedFetchResult = { kind: "ok", finalUrl: "https://fixture.local/story-1", bytes: Buffer.from("{}"), contentHash: "d".repeat(64) };
const STAGED: RunConnectorResult = { kind: "staged", candidateIds: [`${IDENTITY.slug}-1`] };
/** Every gate passed: the steps a successful run reaches before the fetch. */
const GATES = ["profile", "config fixture fixture.local 0", `select ${IDENTITY.idempotencyKey}`, `audit public ${preflightCandidateId(IDENTITY.slug)}`, "interval fixture"];

/** What the memory steps answer, where a case says so. */
interface RunWorld {
  profile?: null; config?: config.ConnectorConfigRead; selection?: object; audit?: RunConnectorResult; interval?: RunConnectorResult;
  fetched?: ConfinedFetchResult; locked?: boolean; staged?: RunConnectorResult | Error;
}

/** Memory run steps; each call logged, each prepared draft kept. */
function stepsOf(log: string[], world: RunWorld = {}): ConnectorRunSteps & { prepared: PreparedDraft[] } {
  const prepared: PreparedDraft[] = [];
  return {
    prepared,
    loadProfile: async () => { log.push("profile"); return world.profile === null ? undefined : { profile: NEWSROOM_PROFILE } as never; },
    loadConfig: async (id, hosts, min) => { log.push(`config ${id} ${hosts.join(",")} ${min}`); return world.config ?? { kind: "ok", config: CONFIG }; },
    selectCandidates: async (key) => { log.push(`select ${key}`); return (world.selection ?? { entries: [] }) as never; },
    preflightAudit: async (_identity, supersedable, _now, policy) => { log.push(`audit ${policy} ${supersedable.preflightStagedId}`); return world.audit ?? null; },
    enforceInterval: async (id) => { log.push(`interval ${id}`); return world.interval ?? null; },
    acquireLock: async () => { log.push("lock"); return world.locked ?? true; },
    releaseLock: async () => { log.push("release"); },
    stage: async (draft) => {
      log.push(`stage ${draft.entityType}/${draft.slug}`); prepared.push(draft);
      if (world.staged instanceof Error) throw world.staged;
      return world.staged ?? STAGED;
    },
  };
}

/** Run `connectorId` over memory steps and a memory fetcher: the result (or fault), the log and the drafts staged. */
async function run(world: RunWorld = {}, connectorId = "fixture") {
  const log: string[] = [];
  const steps = stepsOf(log, world);
  const deps: RunConnectorDeps = {
    now: () => NOW,
    fetcher: async (request) => { log.push(`fetch ${request.url} ${request.headers?.["User-Agent"]}`); return world.fetched ?? FETCHED; },
  };
  const result = await runConnectorWith(steps, connectorId, INPUTS, deps).catch((error: Error) => error);
  return { result, log, prepared: steps.prepared };
}

describe("the connector run as a root-free body", () => {
  it("G1 every gate, then the fetch with the polite agent, then the lock, the stage of the composed draft, and the release", async () => {
    const { result, log, prepared } = await run();
    expect([result, log]).toEqual([STAGED, [...GATES, expect.stringMatching(/^fetch https:\/\/fixture\.local\/story-1 llmwiki\/\S+ \(mailto:ops@example\.com\)$/),
      "lock", `stage articles/${IDENTITY.slug}`, "release"]]);
    expect(prepared[0]).toMatchObject({ entityType: "articles", slug: IDENTITY.slug, idempotencyKey: IDENTITY.idempotencyKey, contentHash: FETCHED.contentHash, finalUrl: FETCHED.finalUrl });
    expect(prepared[0]!.body).toContain("Fixture body field prose");
    expect(prepared[0]!.provenance).toMatchObject({ fetchedAt: NOW.toISOString(), externalFields: ["headline", "stage"] });
  });

  it("G2 an unknown connector, an inactive one, no profile and an unavailable config each refuse where they stand", async () => {
    expect(await run({}, "nope")).toMatchObject({ result: { kind: "refused", reason: "unknown connector" }, log: [] });
    expect(await run({ profile: null })).toMatchObject({ result: { kind: "refused", reason: "connectors require a non-default profile" }, log: ["profile"] });
    expect(await run({ config: { kind: "unavailable", reason: "config unreadable" } })).toMatchObject({ result: { kind: "unavailable", reason: "config unreadable" }, log: GATES.slice(0, 2) });
    stubEnv("LLMWIKI_CONNECTORS", "");
    expect(await run()).toMatchObject({ result: { kind: "refused", reason: "connector is not activated" }, log: ["profile"] });
  });

  it("G3 a selection, audit or rate refusal stops before the fetch, the lock and the stage", async () => {
    const refusal = { kind: "unavailable", reason: "held" } as const;
    expect(await run({ selection: refusal })).toMatchObject({ result: refusal, log: GATES.slice(0, 3) });
    expect(await run({ audit: refusal })).toMatchObject({ result: refusal, log: GATES.slice(0, 4) });
    expect(await run({ interval: { kind: "refused", reason: "too soon" } })).toMatchObject({ result: { kind: "refused", reason: "too soon" }, log: GATES });
  });

  it("G4 a fetch refusal takes no lock; a busy lock after the fetch stages nothing and releases nothing", async () => {
    const fetchRefused = await run({ fetched: { kind: "refused", reason: "host not allowed" } as never });
    expect([fetchRefused.result, fetchRefused.log.slice(GATES.length + 1)]).toEqual([{ kind: "refused", reason: "host not allowed" }, []]);
    const busy = await run({ locked: false });
    expect([busy.result, busy.log.slice(GATES.length + 1)]).toEqual([{ kind: "unavailable", reason: "connector candidate store locked" }, ["lock"]]);
  });

  it("G5 a stage result with invalid ids leaves through the public check; a stage fault still releases", async () => {
    const invalid = await run({ staged: { kind: "staged", candidateIds: ["../escape"] } });
    expect([invalid.result, invalid.log.at(-1)]).toEqual([{ kind: "unavailable", reason: "connector returned invalid candidate identities" }, "release"]);
    const faulted = await run({ staged: new Error("disk full") });
    expect([(faulted.result as Error).message, faulted.log.at(-1)]).toEqual(["disk full", "release"]);
  });
});

describe("the root form", () => {
  it("Z1 hands each incumbent the root and its old arguments", async () => {
    const spies = {
      profile: vi.spyOn(profileBlock, "loadNonDefaultProfile").mockResolvedValue({ profile: NEWSROOM_PROFILE } as never),
      config: vi.spyOn(config, "loadConnectorConfig").mockResolvedValue({ kind: "ok", config: CONFIG }),
      select: vi.spyOn(supersession, "selectConnectorCandidateEntriesForRun").mockResolvedValue({ entries: [] } as never),
      audit: vi.spyOn(audit, "preflightAuditCapacity").mockResolvedValue(null), interval: vi.spyOn(rateLimit, "enforceRequestInterval").mockResolvedValue(null),
      lock: vi.spyOn(lockGate, "acquireMutationLock").mockResolvedValue(true), stage: vi.spyOn(stageDraft, "stagePreparedDraft").mockResolvedValue(STAGED),
      release: vi.spyOn(lock, "releaseLock").mockResolvedValue(),
    };
    const deps: RunConnectorDeps = { now: () => NOW, fetcher: async () => FETCHED };
    expect(await runConnector(ROOT, "fixture", INPUTS, deps)).toEqual(STAGED);
    expect([spies.profile.mock.calls[0], spies.config.mock.calls[0], spies.select.mock.calls[0]]).toEqual([[ROOT], [ROOT, "fixture", ["fixture.local"], 0], [ROOT, IDENTITY.idempotencyKey, undefined]]);
    expect([spies.audit.mock.calls[0]?.slice(0, 2), spies.audit.mock.calls[0]?.[4], spies.interval.mock.calls[0]?.slice(0, 3)]).toEqual([[ROOT, IDENTITY], "public", [ROOT, "fixture", CONFIG]]);
    expect([spies.lock.mock.calls[0], spies.stage.mock.calls[0]?.[0], spies.stage.mock.calls[0]?.[2], spies.release.mock.calls[0]]).toEqual([[ROOT, "ordinary", { quiet: true }], ROOT, deps, [ROOT]]);
  });
});
