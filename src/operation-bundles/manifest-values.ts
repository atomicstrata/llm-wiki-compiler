/**
 * @file src/operation-bundles/manifest-values.ts
 * @description Shared bounded-value readers for the closed operation-manifest
 * grammar. These helpers rebuild JSON data without executable values.
 */

import { Buffer } from "node:buffer";
import type { OperationDataValue, OperationDigest } from "./types.js";

export type JsonRecord = Record<string, unknown>;

export const MAX_LIST_ITEMS = 256;
const MAX_TEXT_BYTES = 1_024;
const MAX_DATA_BYTES = 64 * 1_024;
const MAX_DATA_DEPTH = 8;
const MAX_DATA_NODES = 256;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PAYLOAD_REF = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Require a plain JSON object. */
export function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

/** Reject missing and unknown keys before any field is trusted. */
export function exact(obj: JsonRecord, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(obj).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new Error(`unknown field ${unknown}`);
  const missing = required.find((key) => !Object.hasOwn(obj, key));
  if (missing !== undefined) throw new Error(`missing field ${missing}`);
}

/** Parse one bounded list with a stable index-aware parser. */
export function parseList<T>(
  value: unknown,
  label: string,
  parser: (item: unknown, index: number) => T,
): T[] {
  return array(value, label, MAX_LIST_ITEMS).map(parser);
}

/** Require an array beneath its declared item cap. */
export function array(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} exceeds its item cap`);
  return value;
}

/** Reject duplicate identities in one bounded parsed list. */
export function unique<T extends Record<K, string>, K extends keyof T>(
  items: T[],
  key: K,
  label: string,
): T[] {
  if (new Set(items.map((item) => item[key])).size !== items.length) {
    throw new Error(`${label} contains duplicate identities`);
  }
  return items;
}

/** Parse one bounded non-control Unicode string. */
export function textValue(value: unknown, label: string, maximumBytes = MAX_TEXT_BYTES): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumBytes || CONTROL.test(value)
    || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

/** Parse one canonical prefixed SHA-256 digest. */
export function digest(value: unknown, label: string): OperationDigest {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new Error(`${label} must be a canonical digest`);
  }
  return value as OperationDigest;
}

/** Parse one lowercase raw SHA-256 payload filename. */
export function payloadRef(value: unknown, label: string): string {
  if (typeof value !== "string" || !PAYLOAD_REF.test(value)) {
    throw new Error(`${label} must be lowercase SHA-256`);
  }
  return value;
}

/** Parse one nonnegative safe integer count. */
export function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  return value as number;
}

/** Parse one boolean without coercion. */
export function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

/** Parse one value from a closed string literal set. */
export function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${label} is unsupported`);
  return value as T[number];
}

/** Parse one exact millisecond UTC timestamp. */
export function timestamp(value: unknown): string {
  const text = textValue(value, "createdAt");
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
    throw new Error("createdAt must be canonical ISO timestamp");
  }
  return text;
}

/** Rebuild a bounded, data-only JSON object. */
export function boundedDataObject(value: unknown, label: string): Readonly<Record<string, OperationDataValue>> {
  const budget = { nodes: 0 };
  const rebuilt = rebuildData(record(value, label), label, 0, budget);
  if (Array.isArray(rebuilt) || rebuilt === null || typeof rebuilt !== "object") {
    throw new Error(`${label} must be an object`);
  }
  if (Buffer.byteLength(JSON.stringify(rebuilt), "utf8") > MAX_DATA_BYTES) {
    throw new Error(`${label} exceeds its byte cap`);
  }
  return rebuilt as Readonly<Record<string, OperationDataValue>>;
}

/** Recursively rebuild one bounded JSON value. */
function rebuildData(value: unknown, label: string, depth: number, budget: { nodes: number }): OperationDataValue {
  budget.nodes += 1;
  if (depth > MAX_DATA_DEPTH) throw new Error(`${label} exceeds its depth cap`);
  if (budget.nodes > MAX_DATA_NODES) throw new Error(`${label} exceeds its node cap`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return scalarData(value, label);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => rebuildData(item, label, depth + 1, budget));
  return rebuildDataRecord(record(value, label), label, depth, budget);
}

/** Rebuild a JSON scalar while applying the manifest text bound. */
function scalarData(value: null | boolean | string, label: string): null | boolean | string {
  if (typeof value !== "string") return value;
  if (CONTROL.test(value) || Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) {
    throw new Error(`${label} contains an invalid string`);
  }
  return value;
}

/** Rebuild a JSON object without inheriting caller-controlled prototypes. */
function rebuildDataRecord(
  value: JsonRecord,
  label: string,
  depth: number,
  budget: { nodes: number },
): Record<string, OperationDataValue> {
  const result: Record<string, OperationDataValue> = Object.create(null) as Record<string, OperationDataValue>;
  for (const [key, item] of Object.entries(value)) {
    textValue(key, `${label} key`);
    result[key] = rebuildData(item, label, depth + 1, budget);
  }
  return result;
}
