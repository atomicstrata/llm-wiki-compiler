/** Process-local FIFO admission with a bound on time without queue progress. */

interface Waiter {
  grant: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  timeoutMs: number;
  timeoutError: () => Error;
}

interface QueueState {
  waiters: Waiter[];
}

const queues = new Map<string, QueueState>();

function armTimeout(key: string, state: QueueState, waiter: Waiter): void {
  clearTimeout(waiter.timer);
  waiter.timer = setTimeout(() => {
    const index = state.waiters.indexOf(waiter);
    if (index < 0) return;
    state.waiters.splice(index, 1);
    waiter.reject(waiter.timeoutError());
  }, waiter.timeoutMs);
}

function makeRelease(key: string, state: QueueState): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = state.waiters.shift();
    if (next === undefined) {
      queues.delete(key);
      return;
    }
    clearTimeout(next.timer);
    for (const waiter of state.waiters) armTimeout(key, state, waiter);
    next.grant(makeRelease(key, state));
  };
}

export async function acquireKeyedFifo(
  key: string,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<() => void> {
  const existing = queues.get(key);
  if (existing === undefined) {
    const state: QueueState = { waiters: [] };
    queues.set(key, state);
    return makeRelease(key, state);
  }

  return new Promise<() => void>((grant, reject) => {
    const waiter: Waiter = {
      grant,
      reject,
      timer: undefined as unknown as NodeJS.Timeout,
      timeoutMs,
      timeoutError,
    };
    existing.waiters.push(waiter);
    armTimeout(key, existing, waiter);
  });
}
