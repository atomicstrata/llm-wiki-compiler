/**
 * @file test/helpers/gated-provider.ts
 * @description TEST ONLY. A model double whose calls wait until the test
 * answers them, for witnesses of how a compile's limited fan-outs behave when
 * one call fails: which calls started, which never did, and what had settled
 * when the failure escaped. Ordering comes from explicit handshakes
 * (`whenStarted`, `answer`, one `drainTurn`), never from sleeps.
 *
 * It is the deterministic {@link FixtureProvider}: an extraction is keyed by
 * its source's first `#` heading and answers that heading as the one concept;
 * a page is keyed by the concept its request names. A kind of call that is
 * not gated answers at once with the fixture answer (still recorded). A gated
 * call answers with the fixture answer, a replacement text, or a thrown
 * error. A fatal error is 4xx-shaped, which `callClaude` never retries.
 */

import { expect } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import type { LLMMessage, LLMTool } from "../../src/utils/provider.js";
import { FixtureProvider } from "../fixtures/fixture-provider.js";

/** What a test answers one gated call with: the fixture answer, a replacement text, or a thrown error. */
export type GatedAnswer = undefined | string | Error;
/** The kinds of model call a compile makes per source and per page. */
export type GatedKind = "extract" | "page";

/** The calls of one kind: which started, which wait for an answer. */
class Gate {
  readonly started: string[] = [];
  private readonly waiting = new Map<string, (answer: GatedAnswer) => void>();
  private arrival: { count: number; resolve: () => void } | null = null;

  /** Record a call for `key`; resolve any `whenStarted` it completes. */
  record(key: string): void {
    this.started.push(key);
    if (this.arrival && this.started.length >= this.arrival.count) this.arrival.resolve();
  }

  /** Record a call for `key` and wait for the test's answer. */
  enter(key: string): Promise<GatedAnswer> {
    const answer = new Promise<GatedAnswer>((resolve) => this.waiting.set(key, resolve));
    this.record(key);
    return answer;
  }

  /** Resolves once `count` calls have started. */
  whenStarted(count: number): Promise<void> {
    if (this.started.length >= count) return Promise.resolve();
    return new Promise((resolve) => { this.arrival = { count, resolve }; });
  }

  /** Answer the waiting call for `key`. */
  answer(key: string, given: GatedAnswer): void {
    const resolve = this.waiting.get(key);
    if (!resolve) throw new Error(`no gated call is waiting for "${key}"`);
    resolve(given);
  }
}

/** The fixture model with the chosen kinds of call gated. */
export class GatedProvider extends FixtureProvider {
  private readonly gates: Record<GatedKind, Gate> = { extract: new Gate(), page: new Gate() };

  constructor(private readonly gated: ReadonlySet<GatedKind>) { super(); }

  /** A page call, keyed by the concept it names. */
  override async complete(system: string, messages: LLMMessage[]): Promise<string> {
    const key = /"(.+)"/u.exec(String(messages[0]?.content ?? ""))?.[1] ?? "";
    return this.pass("page", key, () => super.complete(system, messages));
  }

  /** An extraction call, keyed by its source's first heading. */
  override async toolCall(system: string, messages: LLMMessage[], tools: LLMTool[]): Promise<string> {
    const key = /--- SOURCE DOCUMENT ---[\s\S]*?^#+\s*(.+)$/mu.exec(system)?.[1]?.trim() ?? "";
    return this.pass("extract", key, () => super.toolCall(system, messages, tools));
  }

  /** The keys of the calls of `kind` that started, in start order. */
  started(kind: GatedKind): readonly string[] { return this.gates[kind].started; }

  /** Resolves once `count` calls of `kind` have started. */
  whenStarted(kind: GatedKind, count: number): Promise<void> { return this.gates[kind].whenStarted(count); }

  /** Answer the waiting call of `kind` for `key` (the fixture answer by default). */
  answer(kind: GatedKind, key: string, given?: GatedAnswer): void { this.gates[kind].answer(key, given); }

  /** Answer at once when `kind` is not gated; otherwise wait for the test. */
  private async pass(kind: GatedKind, key: string, fixture: () => Promise<string>): Promise<string> {
    if (!this.gated.has(kind)) { this.gates[kind].record(key); return fixture(); }
    const given = await this.gates[kind].enter(key);
    if (given instanceof Error) throw given;
    return given ?? fixture();
  }
}

/** A fatal provider failure: a 400 is never retried by `callClaude`. */
export const fatal = (label: string): Error => Object.assign(new Error(`400 fatal model error (${label})`), { status: 400 });

/** Let every already-queued continuation run (one macrotask turn), without waiting on a clock. */
export const drainTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Fail any test of the calling file that leaves an unhandled rejection behind. */
export function expectNoUnhandledRejections(): void {
  let unhandled: unknown[] = [];
  const recordUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  beforeEach(() => { unhandled = []; process.on("unhandledRejection", recordUnhandled); });
  afterEach(async () => {
    await drainTurn();
    process.off("unhandledRejection", recordUnhandled);
    expect(unhandled).toEqual([]);
  });
}
