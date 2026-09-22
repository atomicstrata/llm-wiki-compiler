/**
 * Track host effects independently of whether their caller awaits them. A native
 * Promise subclass lets await/then/catch observe ownership of the result, while
 * the host's internal settlement listener does not claim that ownership. Chained
 * results are ordinary promises: callers own their error handling from then on.
 */
class ObservedEffect<T> extends Promise<T> {
  observed = false;

  /** Avoid propagating host bookkeeping into caller-owned promise chains. */
  static get [Symbol.species](): PromiseConstructor { return Promise; }

  /** Observe settlement internally without claiming the caller handled it. */
  settled(rejected: (reason: unknown) => void): Promise<void> {
    return super.then(() => undefined, rejected);
  }

  /** Await on this subclass also uses then, unlike await on a native Promise. */
  override then<TResult1 = T, TResult2 = never>(
    fulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    this.observed = true;
    return super.then(fulfilled, rejected);
  }
}

/** Retain completion and unobserved failure without causing unhandled rejection. */
export function trackHostEffect<T>(effect: () => Promise<T>) {
  const result = new ObservedEffect<T>((resolve, reject) => {
    Promise.resolve().then(effect).then(resolve, reject);
  });
  const state = { failed: false, error: undefined as unknown };
  const settled = result.settled(error => { state.failed = true; state.error = error; });
  return { result, settled, unobservedFailure: () => state.failed && !result.observed,
    failure: () => state.error };
}
