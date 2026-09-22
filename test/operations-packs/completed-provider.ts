/** Deterministic provider completion without output for recipe-routing tests. */
import type { ProviderInvokeFn } from "../../src/preparations/attempts/provider.js";

/** Complete without claiming evidence, receipts, or measured model usage. */
export const completed: ProviderInvokeFn = async () => ({
  kind: "completed",
  admitted: {
    outcome: "succeeded", acceptedArtifacts: [], receipts: [],
    usage: { brokerRequestCount: 0, tokenCount: "unobserved", costMicros: "unobserved" },
    counts: { declared: 0, acceptedArtifacts: 0, requiredMissing: 0, receipts: 0 },
    untrusted: { untrusted: true, providerReportedCounts: null, warnings: null, output: null },
  },
});
