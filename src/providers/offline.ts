/**
 * @file Offline deterministic LLM provider — the credential-free stand-in every
 * llmwiki verb can run under (`LLMWIKI_PROVIDER=offline`).
 *
 * It exists so a demo, a hermetic test, or a cold consumer can drive the whole
 * product surface (compile, query, workflows) with NO network and NO key. It is
 * deliberately dumb and honest about it:
 *
 *   - `complete` returns the FIRST message's content verbatim (the contract the
 *     repository's keyless witnesses have relied on through every journey stage);
 *   - `stream` emits that same text once through `onToken`;
 *   - `toolCall` returns SCHEMA-EMPTY JSON for the first tool — every required
 *     property of its input schema present with an empty value of its declared
 *     type — so structured parsers admit the output and select nothing;
 *   - `embed` is a hashed bag-of-words vector (64 dimensions, L2-normalised), so
 *     lexical overlap ranks retrieval deterministically.
 *
 * The provider is NOT tool-aware and never inspects a tool's name: an answer
 * depends only on the bytes it was handed.
 */

import { createHash } from "node:crypto";
import type { EmbeddingInputType, LLMMessage, LLMProvider, LLMTool } from "../utils/provider.js";

/** The fixed embedding width of the offline provider. */
export const OFFLINE_EMBEDDING_DIMENSIONS = 64;

/** Thrown when a call shape the offline provider cannot answer honestly is made. */
export class OfflineProviderError extends Error {}

export class OfflineProvider implements LLMProvider {
  async complete(_system: string, messages: LLMMessage[], _maxTokens: number): Promise<string> {
    return firstMessageContent(messages);
  }

  async stream(
    system: string, messages: LLMMessage[], maxTokens: number, onToken?: (text: string) => void,
  ): Promise<string> {
    const text = await this.complete(system, messages, maxTokens);
    onToken?.(text);
    return text;
  }

  async toolCall(_system: string, _messages: LLMMessage[], tools: LLMTool[], _maxTokens: number): Promise<string> {
    const tool = tools[0];
    if (tool === undefined) throw new OfflineProviderError("offline toolCall needs at least one tool");
    return JSON.stringify(schemaEmptyValue(tool.input_schema));
  }

  async embed(text: string, _inputType?: EmbeddingInputType): Promise<number[]> {
    return bagOfWordsVector(text);
  }

  async embedBatch(texts: string[], inputType?: EmbeddingInputType): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text, inputType)));
  }
}

/** The echo contract: the first message's content, exactly. */
function firstMessageContent(messages: LLMMessage[]): string {
  const first = messages[0];
  if (first === undefined) throw new OfflineProviderError("offline complete needs at least one message");
  return first.content;
}

/**
 * Build the emptiest value a JSON schema admits: objects carry every REQUIRED
 * property (recursively), arrays are empty, strings empty, numbers zero,
 * booleans false, anything else null. Optional properties are omitted.
 */
export function schemaEmptyValue(schema: Record<string, unknown>): unknown {
  switch (schema.type) {
    case "object": return emptyObject(schema);
    case "array": return [];
    case "string": return "";
    case "number": case "integer": return 0;
    case "boolean": return false;
    default: return null;
  }
}

function emptyObject(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : [];
  const out: Record<string, unknown> = {};
  for (const key of required) {
    const property = properties[key];
    out[key] = isRecord(property) ? schemaEmptyValue(property) : null;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deterministic hashed bag-of-words embedding: each lowercase word token is
 * hashed (sha256) into one of the fixed dimensions with a sign, counts are
 * accumulated, and the vector is L2-normalised. Empty text yields a unit
 * vector on a fixed axis so the store never holds a zero vector.
 */
export function bagOfWordsVector(text: string): number[] {
  const vector = new Array<number>(OFFLINE_EMBEDDING_DIMENSIONS).fill(0);
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt32BE(0) % OFFLINE_EMBEDDING_DIMENSIONS;
    const sign = (digest[4]! & 1) === 0 ? 1 : -1;
    vector[index] = vector[index]! + sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) { vector[0] = 1; return vector; }
  return vector.map((value) => value / norm);
}
