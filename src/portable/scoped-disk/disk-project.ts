/**
 * @file src/portable/scoped-disk/disk-project.ts
 * @description The scoped surface of one registered directory that has
 * adopted format 2: propose from a declared disk scope, review what it
 * covered, approve exactly what was reviewed, apply it, and ask where one
 * source's canonical state stands — beside, never instead of, version 1.
 *
 * Review, approval and apply are the SAME protocol version 1 and slice S2a
 * use, given this path's hooks. Every write and read decides from the CURRENT
 * registration: a project that has not adopted format 2 refuses every write
 * by name and shows nothing, so a session opened earlier never acts on an
 * older answer. Reads are authorized from current, bound host state, and the
 * last decision before delivery is that check, made inside the read view.
 *
 * In-process only: these methods run host-side over a runtime.
 */

import { ACCESS_NOTICE, type LabelSet, type Permission } from "../contracts.js";
import type { LabelledResult } from "../project/api.js";
import { apply } from "../project/apply.js";
import { withProjectRead } from "../project/reads.js";
import { approve, getCandidate, listCandidates } from "../project/review.js";
import type { ProjectRuntime } from "../project/runtime.js";
import { requireScopedAuthority, scopedAuthority, SCOPED_VERBS } from "../scoped/scoped-authority.js";
import { clearedPublished } from "../scoped/cleared-published.js";
import { DiskProjectStore } from "../store/disk-store.js";
import type { ReadView } from "../store/store.js";
import { emptyDiskWork, type DiskScopedWork } from "./disk-access.js";
import {
  DISK_SCOPED_CAPABILITY, DISK_SCOPED_CEILINGS, DISK_SCOPED_PROTOCOL_V2,
  type DiskScopedCapabilitiesV2, type DiskScopedCoverageV2, type DiskScopedProjectV2, type DiskScopedUnsupportedV2, type DiskSourceStatusV2,
} from "./disk-contracts.js";
import { diskFormatRefusal, proposeDiskScoped } from "./disk-propose.js";
import { loadDiskCoverage, diskProposalPaths } from "./disk-records.js";
import { diskApplyPath, diskVerifier } from "./disk-review.js";
import { sourceStatusIn } from "./disk-status.js";

/** The one refusal a project that has not adopted format 2 gives. */
const DISK_UNSUPPORTED: DiskScopedUnsupportedV2 = {
  kind: "refused", code: "capability_unsupported", capability: DISK_SCOPED_CAPABILITY, notice: ACCESS_NOTICE,
};

/** What this surface declares. */
const CAPABILITIES: DiskScopedCapabilitiesV2 = {
  projectFormat: 2, namespaces: "root-concepts", titles: "complete-list", contextIndex: "none",
  stateCustody: "canonical-state-json", ceilings: DISK_SCOPED_CEILINGS,
};

/** Options: where to accumulate each phase's work, for cost evidence. */
export interface DiskScopedOptions { work?: DiskScopedWork }

/** A found value with the labels of the bytes it came from. */
interface Found<T> { value: T; labels: LabelSet }

/**
 * Run one served read and deliver its value only if the caller is CURRENTLY
 * admitted for its labels — decided last, inside the same read view.
 */
async function deliveredRead<T>(
  runtime: ProjectRuntime, verbs: readonly Permission[], read: (view: ReadView) => Promise<Found<T> | null>,
): Promise<LabelledResult<T>> {
  return withProjectRead(runtime, async (view) => {
    const found = await read(view);
    if (found === null || (await scopedAuthority(runtime, verbs, found.labels)) === null) return { visible: false };
    return { visible: true, value: found.value, labels: found.labels };
  });
}

/** One proposal's coverage, cleared for the labels its commit bound before the stored record is read. */
async function coverageFound(runtime: ProjectRuntime, view: ReadView, proposalOperationId: string): Promise<Found<DiskScopedCoverageV2> | null> {
  const published = await clearedPublished(runtime, view, proposalOperationId, diskProposalPaths(proposalOperationId).coverage);
  return published === null ? null : { value: await loadDiskCoverage(view, proposalOperationId), labels: published.labels };
}

/** The reads of the surface. */
function diskReads(runtime: ProjectRuntime, store: DiskProjectStore, work: DiskScopedWork): Pick<DiskScopedProjectV2, "coverage" | "sourceStatus" | "candidates"> {
  const reader = () => diskVerifier(runtime, store, SCOPED_VERBS.read, work);
  const isAdopted = async () => (await diskFormatRefusal(store)) === null;
  return {
    coverage: async (proposalOperationId) => {
      await requireScopedAuthority(runtime, SCOPED_VERBS.read);
      if (!(await isAdopted())) return { visible: false };
      return deliveredRead(runtime, SCOPED_VERBS.read, (view) => coverageFound(runtime, view, proposalOperationId));
    },
    sourceStatus: async (name) => {
      const authority = await scopedAuthority(runtime, SCOPED_VERBS.sourceStatus);
      if (authority === null || !(await isAdopted())) return { visible: false };
      const { compartment } = authority.record;
      return deliveredRead<DiskSourceStatusV2>(runtime, SCOPED_VERBS.sourceStatus, (view) => sourceStatusIn({ store, view, compartment }, name));
    },
    candidates: {
      list: async (proposalOperationId) => {
        if (!(await isAdopted())) return { items: [], notice: ACCESS_NOTICE };
        const listed = await listCandidates(runtime, proposalOperationId, reader());
        const labels = [...new Set(listed.items.flatMap((item) => item.labels))];
        return (await scopedAuthority(runtime, SCOPED_VERBS.read, labels)) === null ? { items: [], notice: ACCESS_NOTICE } : listed;
      },
      get: async (proposalOperationId, candidateId) => {
        if (!(await isAdopted())) return { visible: false };
        const found = await getCandidate(runtime, proposalOperationId, candidateId, reader());
        if (!found.visible || (await scopedAuthority(runtime, SCOPED_VERBS.read, found.labels)) === null) return { visible: false };
        return found;
      },
      approve: async (request) => {
        if (!(await isAdopted())) return DISK_UNSUPPORTED;
        return approve(runtime, request, diskVerifier(runtime, store, SCOPED_VERBS.approve, work));
      },
    },
  };
}

/**
 * The disk scoped surface of the project a runtime serves. A store that is not
 * a registered directory refuses every write by name and shows nothing.
 */
export function createDiskScopedProject(runtime: ProjectRuntime, options: DiskScopedOptions = {}): DiskScopedProjectV2 {
  const { store } = runtime;
  const work = options.work ?? emptyDiskWork();
  if (!(store instanceof DiskProjectStore)) return unsupportedProject();
  const isAdopted = async () => (await diskFormatRefusal(store)) === null;
  return {
    protocol: DISK_SCOPED_PROTOCOL_V2,
    negotiate: async () => {
      await requireScopedAuthority(runtime, ["project.open"]);
      return (await isAdopted()) ? { kind: "negotiated", protocol: DISK_SCOPED_PROTOCOL_V2, capabilities: CAPABILITIES } : DISK_UNSUPPORTED;
    },
    propose: async (request) => {
      // The coarse check, before any lookup: an unbound caller learns what an absent project tells them.
      await requireScopedAuthority(runtime, SCOPED_VERBS.propose);
      return (await isAdopted()) ? proposeDiskScoped(runtime, store, request, work) : DISK_UNSUPPORTED;
    },
    apply: async (request) => ((await isAdopted()) ? apply(runtime, request, diskApplyPath(runtime, store, SCOPED_VERBS.apply, work)) : DISK_UNSUPPORTED),
    ...diskReads(runtime, store, work),
  };
}

/** Every method of a project whose store is not a registered directory: writes refuse by name, reads show nothing. */
function unsupportedProject(): DiskScopedProjectV2 {
  return {
    protocol: DISK_SCOPED_PROTOCOL_V2,
    negotiate: async () => DISK_UNSUPPORTED,
    propose: async () => DISK_UNSUPPORTED,
    coverage: async () => ({ visible: false }),
    candidates: { list: async () => ({ items: [], notice: ACCESS_NOTICE }), get: async () => ({ visible: false }), approve: async () => DISK_UNSUPPORTED },
    apply: async () => DISK_UNSUPPORTED,
    sourceStatus: async () => ({ visible: false }),
  };
}
