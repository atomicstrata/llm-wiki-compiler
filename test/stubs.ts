/**
 * @file test/stubs.ts
 * @description Reversible stubs for `process.env` entries and `globalThis`
 * properties, for suites running under `bun test`.
 *
 * Bun's test runner has no `stubEnv`/`stubGlobal`. Each stub records the value
 * it replaced the first time a key is touched, so a suite's `afterEach` can put
 * every key back with one `restoreEnv()` / `restoreGlobals()` call, including
 * keys that did not exist before (those are deleted again, not set to
 * `undefined`, which `process.env` would coerce to the string "undefined").
 */

const originalEnv = new Map<string, string | undefined>();
const originalGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();

/** Set (or with `undefined`, remove) one environment variable until `restoreEnv()`. */
export function stubEnv(name: string, value: string | undefined): void {
  if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Put back every environment variable `stubEnv` changed. */
export function restoreEnv(): void {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnv.clear();
}

/** Replace one `globalThis` property until `restoreGlobals()`. */
export function stubGlobal(name: PropertyKey, value: unknown): void {
  if (!originalGlobals.has(name)) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
}

/** Put back every `globalThis` property `stubGlobal` replaced. */
export function restoreGlobals(): void {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<PropertyKey, unknown>)[name];
  }
  originalGlobals.clear();
}
