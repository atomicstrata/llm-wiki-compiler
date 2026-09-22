/**
 * @file src/utils/runtime-capture.ts
 * @description Shared fail-closed capture helpers for untrusted in-process
 * adapter values. They inspect own data descriptors without invoking caller
 * accessors, reject proxies, and copy dense arrays without consulting caller
 * iterators or collection methods.
 */

import { types as utilTypes } from "node:util";

/** Fixed typed error raised when runtime data cannot be safely captured. */
export class RuntimeCaptureError extends Error {
  constructor(message = "runtime boundary value is invalid") {
    super(message);
    this.name = "RuntimeCaptureError";
  }
}

/** Return an object's own keys, translating hostile reflection into refusal. */
function ownKeys(value: object): (string | symbol)[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    throw new RuntimeCaptureError();
  }
}

/** Return one own descriptor without invoking a getter or proxy trap. */
function ownDataValue(value: object, key: PropertyKey): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new RuntimeCaptureError();
  }
  if (!descriptor || !("value" in descriptor)) throw new RuntimeCaptureError();
  return descriptor.value;
}

/** Capture every own string-keyed data property from one plain object. */
export function captureOwnDataRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new RuntimeCaptureError();
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new RuntimeCaptureError();
  }
  if (prototype !== Object.prototype && prototype !== null) throw new RuntimeCaptureError();
  const keys = ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) throw new RuntimeCaptureError();
  const actual = keys as string[];
  const captured = Object.create(null) as Record<string, unknown>;
  for (const key of actual) captured[key] = ownDataValue(value, key);
  return Object.freeze(captured);
}

/**
 * {@link captureOwnDataRecord} as a REFUSAL rather than a throw.
 *
 * A boundary whose every other decline is a returned value needs the capture to
 * decline the same way, and each such boundary was growing its own copy of this
 * four-line wrapper. A copy of a trust-boundary read is the thing that ends up
 * one hazard behind the original, so it lives here once.
 *
 * ONLY THE CAPTURE'S OWN REFUSAL BECOMES `null`. Every hostile-reflection path
 * inside {@link captureOwnDataRecord} is already converted to
 * {@link RuntimeCaptureError}, so anything else escaping is a fault rather than
 * a decision about the value, and reporting a fault as "this input does not
 * qualify" is the collapse this narrow catch exists to prevent.
 */
export function tryCaptureOwnDataRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return capturedOr(() => captureOwnDataRecord(value), () => null);
}

/**
 * Run a capture, converting ONLY the capture's own refusal; rethrow the rest.
 *
 * ONE HOME FOR A RULE THAT WAS HAND-WRITTEN AT EVERY SITE, and the hand-writing
 * is what produced the defect this exists to fix. A bare `catch {}` around a
 * capture collapses two opposite answers: "this input does not qualify", a
 * statement about the caller's value, and "something went wrong reading it",
 * which is not. Reporting the second as the first tells a caller its input is
 * invalid when nothing established that — the same shape as reading EPERM as
 * "the process is gone".
 *
 * THE FAILURE EXPRESSION IS THE CALLER'S, deliberately. These boundaries decline
 * in four different ways — `null`, a domain-typed throw, an `unavailable`
 * record, a boolean — and a helper per expression would be four copies of one
 * rule, which is the situation being removed. The caller supplies `onRefusal`
 * and keeps its own vocabulary; only the CLASSIFICATION lives here.
 *
 * @param capture - The capture to run. Anything it raises that is not a
 *   {@link RuntimeCaptureError} is a fault and propagates.
 * @param onRefusal - How this boundary expresses "the value does not qualify".
 * @returns The captured value, or whatever `onRefusal` returns.
 */
export function capturedOr<T, R>(capture: () => T, onRefusal: () => R): T | R {
  try {
    return capture();
  } catch (error) {
    if (error instanceof RuntimeCaptureError) return onRefusal();
    throw error;
  }
}

/** Require a non-proxy ordinary or null-prototype object with exact string keys. */
export function captureExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  const captured = captureOwnDataRecord(value);
  const actual = Object.keys(captured);
  if (actual.length !== expectedKeys.length) throw new RuntimeCaptureError();
  const expected = new Set(expectedKeys);
  if (actual.some((key) => !expected.has(key))) throw new RuntimeCaptureError();
  return captured;
}

/** The maximum node count one deep capture may traverse before failing closed. */
const MAX_DEEP_CAPTURE_NODES = 100_000;

/**
 * The maximum NESTING one deep capture may descend before failing closed.
 *
 * A node budget bounds total work and does NOT bound stack depth: 20,000 nested
 * objects is well inside the node budget and overflows the stack, so an
 * untrusted tree could turn this fail-closed primitive into an untyped
 * `RangeError` — a fault escaping a boundary whose contract is a typed refusal.
 * Measured at 20,000. The bound is far above any legitimate captured shape here
 * (the deepest declared caller bound is 8), so it refuses only trees that every
 * caller already rejects.
 */
const MAX_DEEP_CAPTURE_DEPTH = 64;

/** Recursively deep-capture one array's elements by own numeric data descriptors. */
function deepCaptureArray(value: readonly unknown[], budget: { nodes: number }, depth: number): readonly unknown[] {
  const lengthValue = ownDataValue(value, "length");
  if (typeof lengthValue !== "number" || !Number.isSafeInteger(lengthValue) || lengthValue < 0) throw new RuntimeCaptureError();
  const out: unknown[] = [];
  for (let index = 0; index < lengthValue; index += 1) out.push(deepCapture(ownDataValue(value, String(index)), budget, depth));
  return Object.freeze(out);
}

/** Recursively deep-capture one plain object's own string-keyed data properties. */
function deepCaptureObject(value: object, budget: { nodes: number }, depth: number): Readonly<Record<string, unknown>> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new RuntimeCaptureError();
  const keys = ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) throw new RuntimeCaptureError();
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    // Strict trust-boundary capture must not promote hidden data into JSON.
    if (!Object.getOwnPropertyDescriptor(value, key)?.enumerable) throw new RuntimeCaptureError();
    out[key] = deepCapture(ownDataValue(value, key), budget, depth);
  }
  return Object.freeze(out);
}

/** True for the primitive `typeof` results that deep capture passes through. */
function isCapturablePrimitive(kind: string): boolean {
  return kind === "string" || kind === "number" || kind === "boolean" || kind === "undefined" || kind === "bigint";
}

/** Deep-capture one object-typed value: copy Uint8Array bytes, recurse arrays/objects. */
function deepCaptureObjectLike(value: object, budget: { nodes: number }, depth: number): unknown {
  if (utilTypes.isProxy(value)) throw new RuntimeCaptureError();
  // BUFFER IS PRESERVED AS BUFFER, and the order matters because `Buffer`
  // extends `Uint8Array`. Returning the widened type for a `Buffer` input made
  // every caller's `as T` cast a lie: the value is typed `Buffer` and is not
  // one, and the failure is SILENT — `toString("hex")` on a `Uint8Array`
  // ignores the encoding and returns comma-joined decimals rather than
  // throwing. It also changes JSON shape, which matters wherever a captured
  // tree is serialized: a `Uint8Array` stringifies to `{"0":1}` and a `Buffer`
  // to `{"type":"Buffer","data":[1]}`.
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) throw new RuntimeCaptureError();
  if (Array.isArray(value)) return deepCaptureArray(value as readonly unknown[], budget, depth);
  return deepCaptureObject(value, budget, depth);
}

/** The recursive worker behind {@link deepCaptureData}, tracking a node budget. */
function deepCapture(value: unknown, budget: { nodes: number }, depth: number): unknown {
  if (budget.nodes-- <= 0 || depth > MAX_DEEP_CAPTURE_DEPTH) throw new RuntimeCaptureError();
  if (value === null) return null;
  const kind = typeof value;
  if (isCapturablePrimitive(kind)) return value;
  if (kind !== "object") throw new RuntimeCaptureError();
  return deepCaptureObjectLike(value as object, budget, depth + 1);
}

/**
 * Recursively capture one untrusted value into a fresh, immutable, data-only tree:
 * primitives pass through; plain objects and arrays are reconstructed field-by-field
 * and frozen; `Uint8Array` bytes are COPIED into a fresh buffer; and accessors,
 * proxies, functions, symbols, non-plain prototypes, and other typed arrays are
 * rejected at EVERY level. The result shares no mutable reference with the caller,
 * so a later mutation of the original cannot change what a validated snapshot
 * executes or is digested against (the trust-boundary primitive for RC-A).
 */
export function deepCaptureData(value: unknown): unknown {
  return deepCapture(value, { nodes: MAX_DEEP_CAPTURE_NODES }, 0);
}

/** Capture a dense bounded array by numeric own data descriptors only. */
export function captureDenseArray<T>(
  value: unknown,
  maximum: number,
  captureItem: (item: unknown, index: number) => T,
  overflowError: () => Error = () => new RuntimeCaptureError(),
): readonly T[] {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new RuntimeCaptureError();
  }
  if (!Array.isArray(value)) throw new RuntimeCaptureError();
  const lengthValue = ownDataValue(value, "length");
  if (typeof lengthValue !== "number" || !Number.isSafeInteger(lengthValue) || lengthValue < 0) {
    throw new RuntimeCaptureError();
  }
  const length = lengthValue;
  if (length > maximum) throw overflowError();
  const captured: T[] = [];
  for (let index = 0; index < length; index += 1) {
    captured.push(captureItem(ownDataValue(value, String(index)), index));
  }
  return Object.freeze(captured);
}
