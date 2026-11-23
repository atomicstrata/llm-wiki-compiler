/**
 * @file test/batch/parity-fixture.ts
 * @description What the batch parity test files share: the starting sources
 * (two concepts shared by sources that fall in different batches of two), and
 * a twin holder whose helpers compile both twins and apply one source change
 * to both. Split out so each parity file stays small enough to run on its own
 * within a bounded test group on slow storage.
 */

import { compileTwins, makeTwin, sourceNaming, useTwinFixture, type Twin } from "./helpers.js";

/** Each durable segment commit costs over a second on the loaded test volume, so a case with several compiles needs minutes. */
export const PARITY_TIMEOUT_MS = 900_000;

/** The starting sources: two concepts shared by sources that fall in different batches of two. */
export const SOURCES = {
  "alpha.md": sourceNaming("Alpha", "Shared Idea", "Alpha Only"),
  "beta.md": sourceNaming("Beta", "Beta Only"),
  "gamma.md": sourceNaming("Gamma", "Shared Idea", "Gamma Thing"),
  "nested/delta.md": sourceNaming("Delta", "Gamma Thing"),
};

/** One test file's twin: created per case, removed after it. */
export interface ParityTwin {
  /** Create the twin projects holding `sources`. */
  start(sources: Readonly<Record<string, string>>): Promise<void>;
  /** Compile both twins (the segmented one in batches of `batchSize`) and expect identical outcomes. */
  compileBoth(batchSize: number): Promise<void>;
  /** Apply the same source change to both twins. */
  onBoth(change: (root: string) => Promise<void>): Promise<void>;
}

/** Register a parity test file's twin fixture. */
export function useParityTwin(): ParityTwin {
  let twin: Twin | undefined;
  useTwinFixture(() => twin);
  return {
    start: async (sources) => { twin = await makeTwin(sources); },
    compileBoth: (batchSize) => compileTwins(twin!, batchSize),
    onBoth: async (change) => { await change(twin!.plain); await change(twin!.segmented); },
  };
}
