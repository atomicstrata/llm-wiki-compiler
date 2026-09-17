/**
 * Advisory pending-candidate report contract. Identity names the exact loaded
 * record and page body; evidence names current source bytes, not a retained
 * generation snapshot. A score exists only for a successfully judged pair.
 */
import type { CitationJudgement } from "./types.js";

export interface CandidateReference {
  id: string;
  target: string;
  generatedAt: string;
  revision: string;
  contentHash: string;
}

export interface CandidateEvidence {
  file: string;
  sourceHash?: string;
  generationHash?: string;
  status: "matches-generation" | "unrecorded" | "changed" | "unavailable";
  lineStart?: number;
  lineEnd?: number;
  spanText?: string;
}

export interface CandidateAssessment {
  id: string;
  candidate: CandidateReference;
  paragraph: number;
  claimText: string;
  evidence?: CandidateEvidence;
  status: "eligible" | "not-sampled" | "judged" | "unjudgeable" | "judge-error";
  reason?: string;
  judgement?: CitationJudgement;
}

export interface CandidateEvalReport {
  selection: "candidates";
  suite: "fast" | "full";
  timestamp: string;
  evidencePolicy: "current-sources";
  judgeUnavailable?: string;
  candidates: CandidateReference[];
  skippedCandidates: Array<{ id: string; reason: string }>;
  coverage: {
    proseParagraphs: number;
    citedParagraphs: number;
    eligiblePairs: number;
    selectedPairs: number;
    judgedPairs: number;
    unjudgeable: number;
    judgeErrors: number;
  };
  meanScore: number | null;
  assessments: CandidateAssessment[];
}
