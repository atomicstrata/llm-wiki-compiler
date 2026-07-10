/**
 * @file src/profile/templates/builtin/autosci/entities.ts
 * @description Entity definitions for the shipped AutoSci profile template.
 */
import type { ProfilePack } from "../../../types.js";

/** AutoSci entity vocabulary copied from the reviewed research proof fixture. */
export const autosciEntities = {
  papers: {
    directory: "wiki/papers",
    contentTiers: ["title", "body"],
    fields: {
      title: { type: "string", required: true },
      authors: { type: "string[]", required: true },
      year: { type: "integer" },
      venue: { type: "string" },
      doi: { type: "string" },
      arxivId: { type: "string" },
      triageNote: { type: "string" },
      distilledSummary: { type: "string" },
      stage: { type: "enum", enum: ["imported", "triaged", "distilled"], required: true },
    },
    lifecycle: {
      field: "stage",
      initial: "imported",
      terminal: ["distilled"],
      transitions: { imported: ["triaged"], triaged: ["distilled"] },
      transitionRequirements: { triaged: ["triageNote"], distilled: ["distilledSummary"] },
    },
  },
  sources: {
    directory: "wiki/sources",
    requiredFields: ["title", "kind", "stage"],
    contentTiers: ["title", "body"],
    fields: {
      title: { type: "string" },
      kind: { type: "enum", enum: ["paper", "repo", "video", "web"] },
      locator: { type: "string" },
      stage: { type: "enum", enum: ["imported", "triaged"] },
    },
    lifecycle: {
      field: "stage",
      initial: "imported",
      terminal: ["triaged"],
      transitions: { imported: ["triaged"] },
    },
  },
  ideas: {
    directory: "wiki/ideas",
    fields: {
      title: { type: "string", required: true },
      rationale: { type: "string", required: true },
      stage: { type: "enum", enum: ["proposed", "explored", "validated", "rejected"], required: true },
    },
    lifecycle: {
      field: "stage",
      initial: "proposed",
      terminal: ["validated", "rejected"],
      transitions: { proposed: ["explored"], explored: ["validated", "rejected"] },
    },
  },
  experiments: {
    directory: "wiki/experiments",
    requiredFields: ["title", "hypothesis", "stage"],
    fields: {
      title: { type: "string" },
      hypothesis: { type: "string" },
      resultSummary: { type: "string" },
      stage: { type: "enum", enum: ["designed", "running", "complete"] },
      result: { type: "artifactRef", artifactTypes: ["experiment-result"] },
    },
    lifecycle: {
      field: "stage",
      initial: "designed",
      terminal: ["complete"],
      transitions: { designed: ["running"], running: ["complete"] },
      transitionRequirements: { complete: ["resultSummary"] },
      transitionRelationRequirements: {
        complete: [{
          relationType: "tests",
          role: "from",
          otherTypes: ["ideas"],
          otherStates: ["proposed", "explored", "validated"],
          minCount: 1,
        }],
      },
    },
  },
  manuscripts: {
    directory: "wiki/manuscripts",
    fields: {
      title: { type: "string", required: true },
      abstract: { type: "string", required: true },
      stage: { type: "enum", enum: ["drafting", "citation-checked", "submitted"], required: true },
    },
    lifecycle: {
      field: "stage",
      initial: "drafting",
      terminal: ["submitted"],
      transitions: { drafting: ["citation-checked"], "citation-checked": ["submitted"] },
      transitionRelationRequirements: {
        submitted: [{ relationType: "cites", role: "from", otherTypes: ["papers"], minCount: 1 }],
      },
    },
  },
  topics: {
    directory: "wiki/topics",
    fields: {
      title: { type: "string", required: true },
      description: { type: "string" },
      stage: { type: "enum", enum: ["emerging", "active", "mature"], required: true },
    },
    lifecycle: {
      field: "stage", initial: "emerging", terminal: ["mature"],
      transitions: { emerging: ["active"], active: ["mature"] },
    },
  },
  "research-concepts": {
    directory: "wiki/research-concepts",
    fields: {
      title: { type: "string", required: true },
      definition: { type: "string", required: true },
      stage: { type: "enum", enum: ["proposed", "established"], required: true },
    },
    lifecycle: {
      field: "stage", initial: "proposed", terminal: ["established"],
      transitions: { proposed: ["established"] },
    },
  },
  methods: {
    directory: "wiki/methods",
    fields: {
      title: { type: "string", required: true },
      summary: { type: "string", required: true },
      stage: { type: "enum", enum: ["proposed", "validated", "deprecated"], required: true },
    },
    lifecycle: {
      field: "stage", initial: "proposed", terminal: ["deprecated"],
      transitions: { proposed: ["validated"], validated: ["deprecated"] },
    },
  },
  foundations: {
    directory: "wiki/foundations",
    fields: {
      title: { type: "string", required: true },
      kind: { type: "enum", enum: ["dataset", "tool", "theory", "benchmark"], required: true },
      stage: { type: "enum", enum: ["candidate", "adopted"], required: true },
    },
    lifecycle: {
      field: "stage", initial: "candidate", terminal: ["adopted"],
      transitions: { candidate: ["adopted"] },
    },
  },
  people: {
    directory: "wiki/people",
    fields: {
      name: { type: "string", required: true },
      affiliation: { type: "string" },
      stage: { type: "enum", enum: ["active", "inactive"], required: true },
    },
    lifecycle: {
      field: "stage", initial: "active", terminal: ["inactive"],
      transitions: { active: ["inactive"] },
    },
  },
  reviews: {
    directory: "wiki/reviews",
    fields: {
      title: { type: "string", required: true },
      summary: { type: "string" },
      verdict: { type: "enum", enum: ["pending", "accept", "revise", "reject"], required: true },
    },
    lifecycle: {
      field: "verdict", initial: "pending", terminal: ["accept", "revise", "reject"],
      transitions: { pending: ["accept", "revise", "reject"] },
    },
  },
  "research-outputs": {
    directory: "wiki/research-outputs",
    fields: {
      title: { type: "string", required: true },
      outputKind: { type: "enum", enum: ["model", "dataset", "report", "code"], required: true },
      stage: { type: "enum", enum: ["planned", "released"], required: true },
    },
    lifecycle: {
      field: "stage", initial: "planned", terminal: ["released"],
      transitions: { planned: ["released"] },
    },
  },
} satisfies ProfilePack["entities"];
