/**
 * @file src/profile/templates/taps/capacity.ts
 * @description Capacity limits, early warnings, and actionable refusal for
 * monotonically growing template-tap continuity state.
 */
import type { TapOperatorState, TapSourceState } from "./state-types.js";

export const MAX_TAP_STATE_BYTES = 4 * 1024 * 1024;
export const MAX_TAP_STATE_ITEMS = 10_000;
export const MAX_TAP_SOURCES = 64;
const WARNING_RATIO = 0.8;

/** Describe continuity collections approaching their hard persistence bound. */
export function tapStateCapacityWarnings(state: TapOperatorState): string[] {
  const warnings = Object.values(state.taps).flatMap(sourceWarnings);
  const tapCount = Object.keys(state.taps).length;
  if (tapCount >= MAX_TAP_SOURCES * WARNING_RATIO) warnings.push(capacityMessage("operator configured taps", tapCount, MAX_TAP_SOURCES));
  const bytes = Buffer.byteLength(JSON.stringify(state, null, 2));
  if (bytes >= MAX_TAP_STATE_BYTES * WARNING_RATIO) warnings.push(capacityMessage("operator state bytes", bytes, MAX_TAP_STATE_BYTES));
  return warnings;
}

/** Refuse a write that cannot be read back, with a scoped recovery command. */
export function assertTapStateCapacity(state: TapOperatorState, serialized: string): void {
  const exhausted = Object.values(state.taps).flatMap(sourceExhaustion);
  if (Object.keys(state.taps).length > MAX_TAP_SOURCES) exhausted.push("configured taps");
  if (Buffer.byteLength(serialized) > MAX_TAP_STATE_BYTES) exhausted.push("operator state bytes");
  if (exhausted.length > 0) {
    throw new Error(`template tap state capacity exhausted (${exhausted.join(", ")}); run 'llmwiki template tap forget <name> --yes' to reset one retained tap explicitly`);
  }
}

function sourceWarnings(source: TapSourceState): string[] {
  return collections(source)
    .filter(([, count]) => count >= MAX_TAP_STATE_ITEMS * WARNING_RATIO)
    .map(([label, count]) => capacityMessage(`${source.name} ${label}`, count, MAX_TAP_STATE_ITEMS));
}

function sourceExhaustion(source: TapSourceState): string[] {
  return collections(source)
    .filter(([, count]) => count > MAX_TAP_STATE_ITEMS)
    .map(([label]) => `${source.name} ${label}`);
}

function collections(source: TapSourceState): Array<[string, number]> {
  const pins = source.publisherPins;
  return [
    ["retired tap keys", source.retiredTapKeyIds.length],
    ["publishers", Object.keys(pins.publishers).length],
    ["key history", Object.keys(pins.keyHistory).length],
    ["coordinates", Object.keys(pins.coordinates).length],
    ["package revocations", pins.revokedPackages.length],
    ["publisher-key revocations", pins.revokedPublisherKeys.length],
  ];
}

function capacityMessage(label: string, current: number, limit: number): string {
  return `${label} is approaching its continuity-state limit (${current}/${limit}); plan an explicit tap trust reset before refresh is refused`;
}
