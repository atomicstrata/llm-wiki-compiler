/**
 * Opt-in, content-free usage receipts for hosts running the compiler as a child.
 * Each observed response is published atomically in a host-owned directory;
 * receipts survive failed compilation and can be replayed without charging twice.
 */
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Counters use inclusive input tokens; cache counters are subsets of input. */
interface ObservedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}

/** Provider metadata contains no endpoint, credential, prompt or generated text. */
interface UsageReceipt {
  provider: "converse" | "openai" | "anthropic" | "voyage";
  model: string;
  requestId?: string | null;
  responseId?: string;
  operation: "complete" | "stream" | "toolCall" | "embed" | "embedBatch";
  usage: ObservedUsage | null;
  usageComplete?: boolean;
}

/** True when the caller explicitly opted into durable usage receipts. */
export function usageEnabled(): boolean {
  const directory = process.env.LLMWIKI_USAGE_DIRECTORY;
  if (!directory) return false;
  if (!path.isAbsolute(directory) || !process.env.LLMWIKI_USAGE_EXECUTION_ID?.trim()) {
    throw Object.assign(new Error("Usage receipts require an absolute directory and execution id"), { nonRetryable: true });
  }
  return true;
}

/** Publish a receipt before validation of generated output can fail. */
export function recordUsage(observe: () => UsageReceipt): void {
  if (!usageEnabled()) return;
  try {
    const receipt = observe();
    const eventId = randomUUID();
    const usage = checkedUsage(receipt.usage);
    const event = { version: 1, eventId, executionId: process.env.LLMWIKI_USAGE_EXECUTION_ID,
      occurredAt: new Date().toISOString(), provider: receipt.provider, model: receipt.model,
      operation: receipt.operation, requestId: receipt.requestId, responseId: receipt.responseId,
      ...usage, usageComplete: receipt.usageComplete !== false && usage.inputTokens !== null && usage.outputTokens !== null };
    publishReceipt(process.env.LLMWIKI_USAGE_DIRECTORY!, eventId, JSON.stringify(event) + "\n");
  } catch (cause) {
    // Retrying inference cannot repair accounting storage and would consume more tokens.
    throw Object.assign(new Error("Could not persist provider usage", { cause }), { nonRetryable: true });
  }
}

/** Validate raw counters and add observed cache tokens without inventing usage. */
export function normalizeUsage(raw: {
  inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown;
} | null | undefined, cacheIsSeparate = false): ObservedUsage | null {
  if (raw == null) return null;
  const input = tokenCount(raw.inputTokens);
  const cacheReadTokens = tokenCount(raw.cacheReadTokens);
  const cacheWriteTokens = tokenCount(raw.cacheWriteTokens);
  return { inputTokens: input === null ? null : input + (cacheIsSeparate ? (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) : 0),
    outputTokens: tokenCount(raw.outputTokens), cacheReadTokens, cacheWriteTokens };
}

/** Missing is unknown; malformed counters must never turn into observed zero. */
function tokenCount(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw Object.assign(new Error("Invalid provider usage counter"), { nonRetryable: true });
  }
  return value;
}

/** Keep incomplete files invisible to collectors until their contents are flushed. */
function publishReceipt(directory: string, eventId: string, data: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const pending = path.join(directory, `${eventId}.pending`);
  const fd = openSync(pending, "wx", 0o600);
  try {
    writeAndCloseReceipt(fd, data);
    renameSync(pending, path.join(directory, `${eventId}.json`));
  } catch (error) {
    try { rmSync(pending, { force: true }); }
    catch { /* Preserve the publication error if cleanup is unavailable. */ }
    throw error;
  }
}

/** Flush and close the file without hiding a write failure behind a close failure. */
function writeAndCloseReceipt(fd: number, data: string): void {
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } catch (error) {
    try { closeSync(fd); }
    catch { /* Preserve the original write or flush error. */ }
    throw error;
  }
  closeSync(fd);
}

/** Reject malformed provider counters instead of recording fabricated zero use. */
function checkedUsage(usage: ObservedUsage | null): ObservedUsage | { inputTokens: null; outputTokens: null } {
  if (usage === null) return { inputTokens: null, outputTokens: null };
  const counters = { ...usage, cacheReadTokens: usage.cacheReadTokens ?? null, cacheWriteTokens: usage.cacheWriteTokens ?? null };
  if (Object.values(counters).some(value => value !== null && (!Number.isSafeInteger(value) || value < 0))
      || (counters.inputTokens !== null && (counters.cacheReadTokens ?? 0) + (counters.cacheWriteTokens ?? 0) > counters.inputTokens)) {
    throw new Error("Invalid provider usage counters");
  }
  return counters;
}
