/**
 * @file src/profile/templates/builtin/autosci/artifacts.ts
 * @description Artifact definitions for the shipped AutoSci profile template.
 */
import type { ProfilePack } from "../../../types.js";

/** AutoSci artifact types copied from the reviewed research proof fixture. */
export const autosciArtifacts = {
  "experiment-result": {
    fileName: "result.json",
    contentKind: "json",
    maxBytes: 65536,
    metadata: {
      accuracy: { type: "number", required: true },
      runtimeMs: { type: "integer" },
      commit: { type: "string" },
    },
  },
  "paper-source-metadata": {
    fileName: "source-metadata.json",
    contentKind: "json",
    maxBytes: 65536,
    metadata: {
      retrievedFrom: { type: "string", required: true },
      retrievedAt: { type: "string" },
    },
  },
  "experiment-plan": {
    fileName: "plan.json",
    contentKind: "json",
    maxBytes: 65536,
    metadata: {
      hypothesis: { type: "string", required: true },
      steps: { type: "integer" },
    },
  },
  "run-log": { fileName: "run.txt", contentKind: "text", maxBytes: 262144 },
  "manuscript-draft": { fileName: "draft.md", contentKind: "text", maxBytes: 262144 },
  "review-packet": {
    fileName: "packet.json",
    contentKind: "json",
    maxBytes: 65536,
    metadata: { verdict: { type: "string", required: true } },
  },
  "rebuttal-response": { fileName: "rebuttal.md", contentKind: "text", maxBytes: 262144 },
} satisfies NonNullable<ProfilePack["artifacts"]>;
