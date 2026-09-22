/** Real page-file setup and conflict assertions shared by update/delete executor journeys. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import { approveRequest, buildRuntime } from "./executor-fixtures.js";

/** Replace the exact authored target bytes without going through the operation under test. */
async function seedJourneyPage(file: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

/** Bind a late-resolved project root to one authored target path and its seed writer. */
export function journeyTarget(root: () => string, directory: string, slug: string) {
  const pagePath = () => path.join(root(), "wiki", directory, `${slug}.md`);
  return { pagePath, seed: (bytes: Buffer) => seedJourneyPage(pagePath(), bytes) };
}

/** A stale authored target must fail its mutation and park instead of being overwritten or deleted. */
export async function expectPageConflict(root: string, staged: Parameters<typeof approveRequest>[0]): Promise<void> {
  const result = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime()));
  expect(result.state).toBe("recovery-required");
  expect(result.counters?.mutations).toMatchObject({ applied: 0, failed: 1 });
}
