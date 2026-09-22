/** @file Preparation-only SDK effect boundary. Host authority is captured once
 * through own data descriptors; request bodies are captured before quiet/async
 * execution. No runtime, clock, approval grant or apply function is exposed. */
import { prepareRecordEffect, type PreparedEffectRefV1 } from "../operation-bundles/prepare-record.js";
import { capturePreparedEffect, observeRecordEffect, retireRecordEffect } from "../operation-bundles/record-effect.js";
import { captureRecordIntent, type RecordIntentV1 } from "../operation-bundles/record-intent.js";
import type { OperationBundleObservationV1 } from "../operation-bundles/observe.js";
import type { OperationPrincipal } from "../operation-bundles/principal.js";
import { textValue } from "../operation-bundles/manifest-values.js";

/** Only explicit preparation is configurable here; approval remains the operator's. */
export interface SdkOperationOptions { id?: string; grants?: readonly "operation-bundle.prepare"[] }
const REFUSALS = ["record-prepare-grant-required", "record-profile-drift", "record-target-invalid",
  "record-lifecycle-transition-unsupported", "record-preimage-drift", "record-target-refused", "effect-intent-conflict",
  "record-preparer-mismatch", "record-retirement-refused", "record-intent-invalid"] as const;
type Refusal = { status: "refused"; code: typeof REFUSALS[number] };
type Unavailable = { status: "unavailable"; detail: string };
export type RecordPreparationResultV1 = { status: "prepared"; ref: PreparedEffectRefV1 } | Refusal | Unavailable;

/** Experimental record-effects surface. Returned references are not approval. */
export interface WikiOperationSurface {
  prepareRecord(intent: RecordIntentV1): Promise<RecordPreparationResultV1>;
  observeEffect(ref: PreparedEffectRefV1): Promise<OperationBundleObservationV1>;
  retireEffect(ref: PreparedEffectRefV1): Promise<OperationBundleObservationV1 | Refusal>;
}

/** An inherited or accessor property cannot manufacture a host capability. */
function own(source: object | undefined, key: string): unknown {
  if (source === undefined) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Capture a closed host configuration and reject non-preparation grants. */
function principalFrom(value: unknown): OperationPrincipal {
  if (value === undefined) return { id: "sdk-consumer", surface: "sdk", grants: [] };
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(key => key !== "id" && key !== "grants")) throw new Error("record-operation-options-invalid");
  return Object.freeze({ id: textValue(own(value, "id") ?? "sdk-consumer", "principalId"),
    surface: "sdk", grants: Object.freeze(capturedGrants(own(value, "grants"))) });
}

/** The preparation-only grant list is captured without evaluating element getters. */
function capturedGrants(supplied: unknown): "operation-bundle.prepare"[] {
  const grants: "operation-bundle.prepare"[] = [];
  if (supplied !== undefined) {
    if (!Array.isArray(supplied) || supplied.length > 1) throw new Error("record-operation-options-invalid");
    for (let index = 0; index < supplied.length; index++) {
      if (own(supplied, String(index)) !== "operation-bundle.prepare") throw new Error("record-operation-options-invalid");
      grants.push("operation-bundle.prepare");
    }
  }
  return grants;
}

/** Unknown exceptions never escape as paths/provider text or false no-effect results. */
function failure(error: unknown): Refusal | Unavailable {
  const code = error instanceof Error ? error.message : "";
  return (REFUSALS as readonly string[]).includes(code)
    ? { status: "refused", code: code as Refusal["code"] }
    : { status: "unavailable", detail: "record operation outcome unavailable" };
}

/** Build the three verbs over one captured principal. `options` is the whole host object. */
export function buildOperationsFacade(root: string, runQuiet: <T>(action: () => Promise<T>) => Promise<T>, options: object): WikiOperationSurface {
  const principal = principalFrom(own(options, "operations"));
  return {
    prepareRecord(input) {
      let intent: RecordIntentV1;
      try { intent = captureRecordIntent(input); }
      catch { return Promise.resolve({ status: "refused", code: "record-intent-invalid" }); }
      return runQuiet(async () => {
        try { return { status: "prepared", ref: await prepareRecordEffect(root, principal, intent) }; }
        catch (error) { return failure(error); }
      });
    },
    observeEffect(input) {
      let ref: PreparedEffectRefV1;
      try { ref = capturePreparedEffect(input); }
      catch { return Promise.resolve({ status: "unavailable", detail: "record effect reference invalid" }); }
      return runQuiet(() => observeRecordEffect(root, ref));
    },
    retireEffect(input) {
      let ref: PreparedEffectRefV1;
      try { ref = capturePreparedEffect(input); }
      catch { return Promise.resolve({ status: "refused", code: "record-intent-invalid" }); }
      return runQuiet(async () => {
        try { return await retireRecordEffect(root, principal, ref); }
        catch (error) { return failure(error); }
      });
    },
  };
}
