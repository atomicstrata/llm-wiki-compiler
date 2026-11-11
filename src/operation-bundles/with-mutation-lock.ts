/** Shared ordinary-mutation lock lifetime; admission still belongs to lock-gate. */
import { acquireMutationLockBlocking } from "./lock-gate.js";
import { releaseLock } from "../utils/lock.js";

/** Release only after successfully acquiring, including when the operation throws. */
export async function withOrdinaryMutationLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return withMutationLock(root, "ordinary", fn);
}

/** The lock for one transition of a running attempt; see the `attempt` gate intent. */
export async function withAttemptMutationLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return withMutationLock(root, "attempt", fn);
}

/** Hold the gated project lock for `fn`, released even when `fn` throws. */
async function withMutationLock<T>(root: string, intent: "ordinary" | "attempt", fn: () => Promise<T>): Promise<T> {
  await acquireMutationLockBlocking(root, intent);
  try {
    return await fn();
  } finally {
    await releaseLock(root);
  }
}
