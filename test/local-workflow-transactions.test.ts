/**
 * @file test/local-workflow-transactions.test.ts
 * @description Real-lock witnesses for the optional engine's core transaction
 * contract. Tests revocation, root/host isolation, cleanup and composition refusal
 * without replacing the production lock or filesystem with a mock authority.
 */
import { describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { createLocalWorkflowTransactions, createLocalWorkflowTransactionScope } from "../src/local-workflow-host/transactions.js";
import {
  assertLocalWorkflowCoreInstance, LocalWorkflowCoreInstanceError, LOCAL_WORKFLOW_CORE_INSTANCE,
  LocalWorkflowTransactionError, type LocalWorkflowTransaction,
} from "../src/local-workflow-host/shared-contracts.js";

const ctx = useConfinementRoots("local-workflow-host");

/** Prove the original lock is available again, then release the probe acquisition. */
async function expectLockReleased(): Promise<void> {
  expect(await acquireLock(ctx.root, { quiet: true })).toBe(true);
  await releaseLock(ctx.root);
}

describe("local workflow host transactions", () => {
  it("constructs and rejects foreign core identity without filesystem effects", async () => {
    const host = createLocalWorkflowTransactions();
    expect(host.coreInstance).toBe(LOCAL_WORKFLOW_CORE_INSTANCE);
    expect(() => assertLocalWorkflowCoreInstance(host)).not.toThrow();
    expect(() => assertLocalWorkflowCoreInstance({ coreInstance: Symbol("another core") }))
      .toThrow(LocalWorkflowCoreInstanceError);
    expect(await readdir(ctx.root)).toEqual([]);
  });

  it("holds the existing lock and expires the handle before returning", async () => {
    const host = createLocalWorkflowTransactions();
    const transaction = await host.withMutation(ctx.root, async (tx) => {
      host.assertActive(tx, ctx.root);
      expect(await acquireLock(ctx.root, { quiet: true })).toBe(false);
      return tx;
    });
    expect(() => host.assertActive(transaction, ctx.root)).toThrow("expired");
    await expectLockReleased();
  });

  it("rejects wrong-root, foreign-host and forged handles", async () => {
    const host = createLocalWorkflowTransactions();
    const other = createLocalWorkflowTransactions();
    await host.withMutation(ctx.root, async (tx) => {
      expect(() => host.assertActive(tx, ctx.outside)).toThrow("wrong-root");
      expect(() => other.assertActive(tx, ctx.root)).toThrow("unknown");
      expect(() => host.assertActive({} as LocalWorkflowTransaction, ctx.root))
        .toThrow(LocalWorkflowTransactionError);
    });
    expect(await readdir(ctx.outside)).toEqual([]);
  });

  it("revokes and releases after a rejected callback, preserving the original error", async () => {
    const host = createLocalWorkflowTransactions();
    const failure = new Error("callback failed");
    let retained: LocalWorkflowTransaction | undefined;
    await expect(host.withMutation(ctx.root, async (tx) => {
      retained = tx;
      throw failure;
    })).rejects.toBe(failure);
    expect(() => host.assertActive(retained!, ctx.root)).toThrow("expired");
    await expectLockReleased();
  });

  it("does not unlock while an admitted host effect is still running", async () => {
    const scope = createLocalWorkflowTransactionScope();
    let unblock!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const completion = scope.transactions.withMutation(ctx.root, async (tx) => {
      void scope.runEffect(tx, ctx.root, async () => { entered(); await blocked; });
    });
    await started;
    try {
      expect(await acquireLock(ctx.root, { quiet: true })).toBe(false);
    } finally {
      unblock();
      await completion;
    }
    await expectLockReleased();
  });

  it("reports an unawaited host failure rather than returning false success", async () => {
    const scope = createLocalWorkflowTransactionScope();
    const failure = new Error("host effect failed");
    await expect(scope.transactions.withMutation(ctx.root, async (tx) => {
      void scope.runEffect(tx, ctx.root, async () => { throw failure; });
    })).rejects.toBe(failure);
    await expectLockReleased();
  });

  it("does not rethrow an awaited effect error handled by the callback", async () => {
    const scope = createLocalWorkflowTransactionScope();
    const failure = new Error("handled host error");
    const result = await scope.transactions.withMutation(ctx.root, async tx => {
      try {
        await scope.runEffect(tx, ctx.root, async () => { throw failure; });
      } catch (error) { expect(error).toBe(failure); }
      return scope.runEffect(tx, ctx.root, async () => "recovered");
    });
    expect(result).toBe("recovered");
    await expectLockReleased();
  });

  it("lets an explicit catch own recovery from an effect failure", async () => {
    const scope = createLocalWorkflowTransactionScope();
    await expect(scope.transactions.withMutation(ctx.root, tx =>
      scope.runEffect(tx, ctx.root, async () => { throw new Error("handled"); })
        .catch(() => "recovered"),
    )).resolves.toBe("recovered");
    await expectLockReleased();
  });
});
