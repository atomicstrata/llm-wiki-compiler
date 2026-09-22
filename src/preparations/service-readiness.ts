/**
 * @file src/preparations/service-readiness.ts
 * @description Whether a project is in a state a preparation operation can act
 * in at all. Both mutating operations take this precheck BEFORE the operator's
 * documents are read, and it moved here from the CLI unchanged.
 *
 * NOT AN AUTHORITY BOUNDARY, and the module it came from previously claimed to
 * be one. It was called a "plan-authority resolver" and returned an "admission
 * digest"; an external review established that it fingerprints a plan and
 * authorizes nothing — it admitted every plan whose project had a readable
 * profile and key, nothing compared a plan's named authorities against any host
 * policy because no registry exists, and the digest reached CLI output and
 * nothing else. The claim was withdrawn rather than dressed up, and it stays
 * withdrawn here: this answers whether the project can be acted in, and says
 * nothing about whether the caller MAY act. Authority is the principal's job
 * (`principals.ts`), one layer up in `service.ts`.
 *
 * THE ORDER IS PART OF THE CONTRACT. The store must exist — staging must never
 * mint a second one as a side effect of running one directory deep — and the
 * project's own configuration must be readable. Neither is a statement about the
 * operator's plan, so both are settled before a single document byte is read.
 */

import { access, stat } from "node:fs/promises";
import path from "node:path";
import { loadProfile } from "../profile/load.js";
import { LLMWIKI_DIR } from "../utils/constants.js";
import { readPreparationKey } from "./key-epoch.js";

/** Whether the project is in a state the caller can act in. */
export interface HostReadinessV1 {
  /** True when the project's own configuration could be read. */
  readonly ready: boolean;
  /** Why not, when `ready` is false. */
  readonly reason: string | null;
}

/**
 * The half of readiness that is about the PROJECT'S OWN CONFIGURATION.
 *
 * SPLIT OUT SO THERE IS ONE READER OF THIS FACT, not two. Every preparation
 * operation needs it, including the one that exists because the key is broken —
 * a reset cannot be attested in a project whose profile will not load either.
 * Writing a second profile check beside {@link resolveHostReadiness} for that
 * caller is how the two would come to disagree about what "present but broken"
 * means; taking a documented SUBSET of the same function cannot.
 *
 * MODULE-PRIVATE, because both consumers live here. Exporting it would put a
 * third readiness entry point on the surface with no caller, and the choice
 * between the three is precisely the decision that produced a defect once.
 *
 * @param root - The project root the operation acts within.
 * @returns Whether the project's configuration could be read, and why not.
 */
async function resolveProfileReadiness(root: string): Promise<HostReadinessV1> {
  const profile = await loadProfile(root).catch(() => null);
  // "missing" would be wrong: `loadProfile` yields the built-in default for a
  // clean project and throws only for a PRESENT-but-broken profile.
  return profile === null
    ? {
      ready: false,
      reason: "the project profile is present but unreadable; preparation commands cannot proceed",
    }
    : { ready: true, reason: null };
}

/**
 * Check that this project's own configuration AND its preparation key are
 * readable.
 *
 * Two things can genuinely fail and both fail CLOSED: a present-but-broken
 * profile, and an unreadable preparation key. An ABSENT key is the healthy
 * pre-staging state — it is minted at first staging — so it does not refuse.
 *
 * NOT FOR `reset`, and that exception is the reason this function is no longer
 * the only readiness there is. An unreadable key refuses here, and an unreadable
 * key is one of exactly two states `reset` exists to repair — so taking this
 * precheck made that verb refuse the state it was built for, with a message
 * saying preparation commands cannot proceed that is true of every command but
 * that one. Reset takes {@link resolveProfileReadiness} and lets the substrate
 * classify the key under the lock, where all three states are already told
 * apart. A guard whose refusal has no exit for the operation that repairs it is
 * a defect rather than caution.
 */
export async function resolveHostReadiness(root: string): Promise<HostReadinessV1> {
  const profile = await resolveProfileReadiness(root);
  if (!profile.ready) return profile;
  const key = await readPreparationKey(root);
  return key.status === "unavailable"
    ? { ready: false, reason: "the preparation key is unreadable; preparation commands cannot proceed" }
    : { ready: true, reason: null };
}

/**
 * What a READ can say about the project it was pointed at.
 *
 * THE THREE ARMS ARE THE PARK-VS-DENY TAXONOMY AT THIS LEG (D-10-4), and
 * collapsing any two of them is the defect this type exists to stop. `absent`
 * DOES NOT QUALIFY — there is no store here, and an operator pointed at the wrong
 * directory needs to be told that rather than handed a confident empty answer.
 * `unreadable` COULD NOT SEE — a store may well be here and this process cannot
 * tell, which is a retryable condition and a completely different instruction.
 */
export type ReadReadinessV1 =
  | { readonly status: "ready" }
  | { readonly status: "absent"; readonly detail: string }
  | { readonly status: "unreadable"; readonly detail: string };

/**
 * Classify the project for a READ verb, splitting could-not-tell from not-there.
 *
 * ONE HOME FOR THE READ FAMILY. `list`, `show` and `preview` all have to answer
 * "is this even a project?" before their answer means anything, and each having
 * its own check is how one of them comes to report an empty store for a directory
 * it could not read. They differ in what they DO with the answer — `list` carries
 * it as a problem because it never refuses, the single-run reads refuse — and
 * that difference belongs to them, not to the classification.
 *
 * IT SPLITS WHAT `missingStoreRefusal` DELIBERATELY DOES NOT. That function
 * collapses a permission fault into the same refusal as a genuine absence, and
 * said so, deferring the split rather than changing a shipped write-path message
 * inside a behaviour-preserving extraction. This is the read-path home where the
 * split is free: nothing shipped depends on these words yet.
 *
 * @param root - The project root the read was pointed at.
 * @returns Whether the store is there, missing, or unobservable.
 */
export async function resolvePreparationReadReadiness(root: string): Promise<ReadReadinessV1> {
  const store = path.join(root, LLMWIKI_DIR);
  try {
    // `stat` RATHER THAN `access`, because the two failures have to be told
    // apart: `access` reports one boolean for "not there" and "not allowed to
    // look", and the whole point of this function is that those are different
    // answers. ENOENT and ENOTDIR are the only ones meaning the store is not
    // there; everything else — EACCES, EPERM, EIO, a loop — means we could not
    // determine it, and must never read as an empty project.
    const stats = await stat(store);
    if (!stats.isDirectory()) {
      return { status: "absent", detail: `${LLMWIKI_DIR} exists here but is not a directory` };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    return code === "ENOENT" || code === "ENOTDIR"
      ? { status: "absent", detail: `no ${LLMWIKI_DIR} store here; run from the project root` }
      : { status: "unreadable", detail: `the ${LLMWIKI_DIR} store could not be read (${code || "unknown error"})` };
  }
  const ready = await resolveHostReadiness(root);
  // A PRESENT STORE WHOSE CONFIGURATION WILL NOT LOAD IS `unreadable`, NOT
  // `absent`: the project is here, something about it cannot be seen, and a
  // reader told "no store here" would go looking in the wrong directory.
  return ready.ready ? { status: "ready" } : { status: "unreadable", detail: ready.reason ?? "the project is not ready" };
}

/**
 * Refuse to MINT a store as a side effect of a mutating operation.
 *
 * The CLI's root is `process.cwd()` with no upward `.llmwiki` discovery. For a
 * read verb that means a wrong message; for a WRITE verb it means running one
 * directory deep silently creates a SECOND store — new key epoch, manifest,
 * evidence, run — invisible to `list` from the project root.
 *
 * Upward discovery is the real fix and belongs in a change that does it for
 * every command. Until then this refuses rather than forks the project.
 *
 * DELIBERATELY DOES NOT SPLIT could-not-tell FROM not-there. `access` collapses
 * a permission fault into the same refusal as a genuine absence, and separating
 * them would change a shipped refusal message. This slice is a behaviour-
 * preserving extraction, so the distinction is named as owed work rather than
 * introduced here alongside it.
 */
async function missingStoreRefusal(root: string): Promise<string | null> {
  const present = await access(path.join(root, LLMWIKI_DIR)).then(() => true, () => false);
  return present
    ? null
    : "no .llmwiki store here; run from the project root rather than creating a second store";
}

/**
 * The preflight for `reset`: the store must be HERE, and the profile readable.
 *
 * THE STORE CHECK MATTERS MORE FOR THIS VERB THAN FOR ANY OTHER, and the reason
 * is that reset cannot tell the two cases apart without it. A bare directory and
 * a real project whose key was deleted give the substrate the SAME answer —
 * `readPreparationKey` reports `absent` for both — so a reset run one directory
 * below the project root looked exactly like the repair it was asked for. It
 * was measured doing precisely that: exit 0, a fresh `.llmwiki` created in a
 * directory that was not a project, a pending reset unit inside it and a
 * continuation token handed back, while the operator's real project stayed
 * broken. Store presence is the ONLY signal that separates them.
 *
 * IT DELIBERATELY OMITS THE KEY CLAUSE that {@link preparationPreflightRefusal}
 * carries. An unreadable key refuses there and is one of the two states this
 * verb repairs, so the key is classified under the lock by the substrate
 * instead — which tells healthy from absent from unreadable and refuses a
 * healthy one outright.
 *
 * @param root - The project root the reset would act within.
 * @returns The refusal, or `null` when the project can be acted in.
 */
export async function preparationResetPreflightRefusal(root: string): Promise<string | null> {
  const blocked = await missingStoreRefusal(root);
  if (blocked !== null) return blocked;
  const profile = await resolveProfileReadiness(root);
  return profile.ready ? null : profile.reason ?? "the project is not ready";
}

/**
 * Everything about the PROJECT that must hold before the operator's documents
 * are read, in the order the shipped commands establish it.
 *
 * A STRICT SUPERSET of the reset preflight, composed from it rather than
 * repeating its two clauses — so the store message and the profile message have
 * one home and the two preflights cannot drift into disagreeing about what
 * "no project here" means. The single added clause is the key.
 */
export async function preparationPreflightRefusal(root: string): Promise<string | null> {
  const blocked = await preparationResetPreflightRefusal(root);
  if (blocked !== null) return blocked;
  const key = await readPreparationKey(root);
  return key.status === "unavailable"
    ? "the preparation key is unreadable; preparation commands cannot proceed"
    : null;
}
