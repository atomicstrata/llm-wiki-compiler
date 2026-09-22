/** Shared storage mechanics for independently keyed run stores; callers own parsing and authentication. */
import { AtomicWriteCollisionError, atomicWriteNoReplaceDurable } from "./atomic-write.js";

/** Classify failed parsing or authentication without allowing a partial run to escape. */
export function authenticatedRunRead<T>(parse: () => T, verify: (run: T) => boolean):
  { status: "ok"; run: T } | { status: "unavailable"; detail: "run-invalid"; code: "run-integrity-invalid" } {
  try {
    const run = parse();
    if (!verify(run)) throw new Error("integrity");
    return { status: "ok", run };
  } catch {
    return { status: "unavailable", detail: "run-invalid", code: "run-integrity-invalid" };
  }
}

/** Publish once; only a real create collision invokes the store-specific readback diagnostic. */
export async function publishRunGenesis(
  location: { root: string; file: string }, serialized: string, collisionMessage: () => Promise<string>,
): Promise<void> {
  try {
    await atomicWriteNoReplaceDurable(location.file, serialized, {
      confineRoot: location.root, exactParent: true, mode: 0o600,
    });
  } catch (error) {
    if (error instanceof AtomicWriteCollisionError) throw new Error(await collisionMessage());
    throw error;
  }
}
