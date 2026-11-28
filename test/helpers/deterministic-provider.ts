/**
 * @file test/helpers/deterministic-provider.ts
 * @description TEST ONLY. A deterministic `LLMProvider` with no network, no
 * credential and no model: every answer is computed by the test from the
 * prompt it was sent. It counts each kind of call, and a provider built
 * without answers THROWS on any call, so a test can prove that a path sends
 * nothing to a model. Tests install it through the existing
 * `runWithProviderOverride` seam (`src/utils/provider.ts`); nothing in `src/`
 * knows it exists, and it is never a fallback.
 */

import { runWithProviderOverride, type LLMMessage, type LLMProvider, type ProviderOverride } from "../../src/utils/provider.js";

/** What a test answers with: an extraction tool result and a generated page (or seed) body. */
export interface DeterministicAnswers {
  /** The tool-call answer for one extraction prompt. */
  extract(system: string): string;
  /** The body for one page or seed generation, from the WHOLE prompt. */
  page(system: string, messages: LLMMessage[]): string;
}

/** How many calls of each kind a provider received. */
export interface ProviderCallCounts { toolCalls: number; completions: number; streams: number; embeddings: number }

/** The name and model id every draft generated under this provider is stamped with. */
const TEST_PROVIDER_NAME = "test-deterministic";
const TEST_MODEL_ID = "test-deterministic-1";

/** A provider that answers from `answers`, or throws on every call when given none. */
export class DeterministicProvider implements LLMProvider {
  readonly counts: ProviderCallCounts = { toolCalls: 0, completions: 0, streams: 0, embeddings: 0 };

  constructor(private readonly answers: DeterministicAnswers | null = null) {}

  /** The answers, or a failure naming the call a model-free path made. */
  private require(call: string): DeterministicAnswers {
    if (this.answers === null) throw new Error(`a model call was made on a path that must send none: ${call}`);
    return this.answers;
  }

  async complete(system: string, messages: LLMMessage[]): Promise<string> {
    this.counts.completions += 1;
    return this.require("complete").page(system, messages);
  }

  async stream(system: string, messages: LLMMessage[], _maxTokens: number, onToken?: (text: string) => void): Promise<string> {
    this.counts.streams += 1;
    const text = this.require("stream").page(system, messages);
    onToken?.(text);
    return text;
  }

  async toolCall(system: string): Promise<string> {
    this.counts.toolCalls += 1;
    return this.require("toolCall").extract(system);
  }

  async embed(): Promise<number[]> {
    this.counts.embeddings += 1;
    throw new Error("the deterministic test provider embeds nothing; compile with embeddings off");
  }

  /** Every call this provider received, of any kind. */
  get totalCalls(): number {
    return this.counts.toolCalls + this.counts.completions + this.counts.streams + this.counts.embeddings;
  }
}

/** The provider override that routes every model call in its scope to `provider`. */
export function overrideOf(provider: LLMProvider): ProviderOverride {
  return { provider, providerName: TEST_PROVIDER_NAME, modelId: TEST_MODEL_ID };
}

/** Run `work` with every model call routed to `provider`. */
export function withProvider<T>(provider: LLMProvider, work: () => T): T {
  return runWithProviderOverride(overrideOf(provider), work);
}
