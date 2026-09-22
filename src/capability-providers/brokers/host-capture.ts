/**
 * @file src/capability-providers/brokers/host-capture.ts
 * @description Runtime capture for host-owned broker definitions. It rejects
 * accessors, proxies, cycles, and exotic prototypes while retaining only the
 * exact function references and deeply frozen inert definition data.
 */
import {
  captureDenseArray, captureOwnDataRecord,
} from "../../utils/runtime-capture.js";

const MAX_HOST_DEFINITION_DEPTH = 16;
const MAX_HOST_DEFINITION_MEMBERS = 16_384;
const CAPTURED_SCALAR_TYPES = new Set(["undefined", "string", "boolean", "function"]);

interface CaptureState {
  members: number;
  readonly seen: WeakSet<object>;
  readonly opaque: ReadonlySet<object>;
}

/** Capture one complete host adapter graph without invoking caller code. */
export function captureHostDefinition<T>(
  value: T, opaque: ReadonlySet<object> = new Set(),
): T {
  try {
    return captureValue(value, 0, { members: 0, seen: new WeakSet(), opaque }) as T;
  } catch { throw new Error("provider broker adapter definition is invalid"); }
}

/** Compare two already captured adapter graphs, including function identity. */
export function sameHostDefinition(
  left: unknown, right: unknown, opaque: ReadonlySet<object> = new Set(),
): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (typeof left !== "object") return false;
  if (opaque.has(left) || opaque.has(right as object)) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => sameHostDefinition(item, right[index], opaque));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord), rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameHostDefinition(leftRecord[key], rightRecord[key], opaque));
}

function captureValue(value: unknown, depth: number, state: CaptureState): unknown {
  if (depth > MAX_HOST_DEFINITION_DEPTH) throw new Error();
  if (value !== null && typeof value === "object") {
    return captureObject(value, depth, state);
  }
  return captureScalar(value);
}

function captureScalar(value: unknown): unknown {
  if (value === null || CAPTURED_SCALAR_TYPES.has(typeof value)) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error();
  return value;
}

function captureObject(value: object, depth: number, state: CaptureState): unknown {
  if (state.opaque.has(value)) return value;
  if (state.seen.has(value)) throw new Error();
  state.seen.add(value);
  const result = Array.isArray(value)
    ? captureArray(value, depth, state) : captureRecord(value, depth, state);
  state.seen.delete(value);
  return result;
}

function captureArray(value: unknown, depth: number, state: CaptureState): readonly unknown[] {
  return captureDenseArray(value, MAX_HOST_DEFINITION_MEMBERS, (item) => {
    debitMember(state);
    return captureValue(item, depth + 1, state);
  });
}

function captureRecord(value: unknown, depth: number, state: CaptureState): Readonly<Record<string, unknown>> {
  const record = captureOwnDataRecord(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    debitMember(state);
    result[key] = captureValue(record[key], depth + 1, state);
  }
  return Object.freeze(result);
}

function debitMember(state: CaptureState): void {
  state.members += 1;
  if (state.members > MAX_HOST_DEFINITION_MEMBERS) throw new Error();
}
