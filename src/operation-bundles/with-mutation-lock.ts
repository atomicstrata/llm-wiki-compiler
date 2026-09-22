/** Shared ordinary-mutation lock lifetime; admission still belongs to lock-gate. */
import { acquireMutationLockBlocking } from "./lock-gate.js";
import { releaseLock } from "../utils/lock.js";

/** Release only after successfully acquiring, including when the operation throws. */
export async function withOrdinaryMutationLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  await acquireMutationLockBlocking(root, "ordinary");
  try {
    return await fn();
  } finally {
    await releaseLock(root);
  }
}
