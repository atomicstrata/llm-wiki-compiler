/**
 * @file test/capability-providers/scheduler-email-brokers.test.ts
 * @description Scheduler and email broker tests for predeclared identities,
 * exact effect plans, deterministic idempotency lookup, and host receipts.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createHostBrokerDispatcher, dispatchHostBrokerRequest,
} from "../../src/capability-providers/brokers/dispatch.js";
import { parseInvocationId } from "../../src/capability-providers/ids.js";
import {
  brokerAtom, brokerEffectId, brokerEnvelope, plannedEffect, prepareBrokerAuthority,
  effectStateAuthority, useBrokerFixtures,
} from "./broker-fixture.js";

const trackFixture = useBrokerFixtures();
const SCHEDULER_EFFECT_ID = brokerEffectId("invocation-messages", 0);
const EMAIL_EFFECT_ID = brokerEffectId("invocation-messages", 1);

describe("scheduler and email brokers", () => {
  it("replays a settled scheduler effect from one shared authority without re-executing", async () => {
    const firstExecute = vi.fn(async () => ({ outcome: "applied" as const, observedExternalIdentity: "job-run-one" }));
    const secondExecute = vi.fn(async () => ({ outcome: "applied" as const, observedExternalIdentity: "job-run-two" }));
    const request = schedulerRequest("daily-job");
    const first = await setup(firstExecute, emailExecutor());
    const second = await setup(secondExecute, emailExecutor(),
      { fixture: first.fixture, effectState: first.effectState });
    const firstResult = await dispatchHostBrokerRequest(first.dispatcher, request);
    const secondResult = await dispatchHostBrokerRequest(second.dispatcher, request);
    expect(firstResult.receipt).toMatchObject({ outcome: "applied", brokerId: "scheduler" });
    expect(secondResult.receipt).toMatchObject({ outcome: "applied", brokerId: "scheduler" });
    expect(secondResult.output).toEqual({ alreadyApplied: true });
    expect(firstExecute).toHaveBeenCalledTimes(1);
    expect(secondExecute).not.toHaveBeenCalled();
  });

  it("refuses an undeclared recipient or template before email I/O", async () => {
    const execute = emailExecutor();
    const approved = emailRequest("recipient-one", "template-one");
    const { dispatcher } = await setup(schedulerExecutor(), execute);
    const hostile = brokerEnvelope("email", {
      operation: "send-report", recipientId: "attacker@example.test",
      templateId: "template-one", variables: { report: "safe" },
    }, EMAIL_EFFECT_ID);
    await expect(dispatchHostBrokerRequest(dispatcher, hostile)).rejects.toThrow(/email.*invalid/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("mints an email receipt without recipient address, body, or secret fields", async () => {
    const request = emailRequest("recipient-one", "template-one");
    const { dispatcher } = await setup(schedulerExecutor(), emailExecutor());
    await dispatchHostBrokerRequest(dispatcher, schedulerRequest("daily-job"));
    const result = await dispatchHostBrokerRequest(dispatcher, request);
    expect(result.receipt).toMatchObject({
      outcome: "applied", targetIdentity: "recipient-one/template-one",
      sensitiveFieldsOmitted: true,
    });
    expect(JSON.stringify(result.receipt)).not.toMatch(/@|body|authorization|token/i);
  });

  it("rejects unknown or type-invalid mutation parameters before adapter I/O", async () => {
    const execute = emailExecutor();
    const { dispatcher } = await setup(schedulerExecutor(), execute);
    const request = brokerEnvelope("email", {
      operation: "send-report", recipientId: "recipient-one", templateId: "template-one",
      variables: { report: 42, extra: true },
    }, EMAIL_EFFECT_ID);
    await expect(dispatchHostBrokerRequest(dispatcher, request)).rejects.toThrow(/parameter|email.*invalid/i);
    expect(execute).not.toHaveBeenCalled();
  });
});

function schedulerRequest(jobId: string) {
  return brokerEnvelope("scheduler", {
    operation: "upsert-daily", jobId, parameters: { hour: 9 },
  }, SCHEDULER_EFFECT_ID);
}

function emailRequest(recipientId: string, templateId: string) {
  return brokerEnvelope("email", {
    operation: "send-report", recipientId, templateId, variables: { report: "safe" },
  }, EMAIL_EFFECT_ID);
}

const SCHEDULER_OPERATION = { operationId: "upsert-daily", jobId: "daily-job",
  targetIdentity: "daily-job", effectClass: "schedule-write",
  parameters: [{ name: "hour", type: "integer" as const }] };
const EMAIL_OPERATION = { operationId: "send-report", recipientId: "recipient-one",
  templateId: "template-one", targetIdentity: "recipient-one/template-one",
  effectClass: "email-send",
  parameters: [{ name: "report", type: "string" as const, maxStringBytes: 128 }] };

interface SchedulerEmailContext {
  readonly fixture: Awaited<ReturnType<typeof prepareBrokerAuthority>>;
  readonly effectState: ReturnType<typeof effectStateAuthority>;
}

async function setup(
  schedulerExecute: ReturnType<typeof schedulerExecutor>,
  emailExecute: ReturnType<typeof emailExecutor>,
  shared?: SchedulerEmailContext,
) {
  const context = shared ?? await schedulerEmailContext();
  const dispatcher = await createHostBrokerDispatcher({
    paths: context.fixture.package.paths, authorityRequest: context.fixture.request,
    invocationId: parseInvocationId("invocation-messages"), brokers: {
      scheduler: { operations: [SCHEDULER_OPERATION], execute: schedulerExecute },
      email: { operations: [EMAIL_OPERATION], execute: emailExecute },
    }, effectState: context.effectState,
  });
  return { dispatcher, ...context };
}

async function schedulerEmailContext(): Promise<SchedulerEmailContext> {
  const scheduler = schedulerRequest("daily-job"), email = emailRequest("recipient-one", "template-one");
  const authority = [
    brokerAtom({ kind: "scheduler.write", brokerId: "scheduler", operation: "upsert-daily",
      target: "daily-job", effectClass: "schedule-write" }),
    brokerAtom({ kind: "email.send", brokerId: "email", operation: "send-report",
      target: "recipient-one/template-one", effectClass: "email-send" }),
  ];
  const effects = [
    plannedEffect(scheduler, "schedule-write", "daily-job", SCHEDULER_EFFECT_ID, SCHEDULER_OPERATION),
    plannedEffect(email, "email-send", "recipient-one/template-one", EMAIL_EFFECT_ID, EMAIL_OPERATION),
  ];
  const fixture = trackFixture(await prepareBrokerAuthority({ authority, effects }));
  return { fixture, effectState: effectStateAuthority() };
}

function schedulerExecutor() {
  return vi.fn(async () => ({ outcome: "applied" as const }));
}
function emailExecutor() {
  return vi.fn(async () => ({ outcome: "applied" as const }));
}
