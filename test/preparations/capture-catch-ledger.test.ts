/**
 * @file test/preparations/capture-catch-ledger.test.ts
 * @description No NEW bare catch may wrap a capture primitive, and the ones that
 * exist are listed here rather than tolerated silently.
 *
 * WHY AN ALLOWLIST RATHER THAN A FLAT PROHIBITION. Forty-two sites still wrap a
 * capture in a bare `catch {}`, each reporting a fault as a claim about the
 * caller's input. A control asserting "none exist" would be red on arrival and
 * would be deleted; one asserting nothing would let the thirty-seventh appear
 * unnoticed. So the list below IS the ledger, made executable: it fails when a
 * NEW site appears, and every migration deletes a line from it. A shrinking
 * allowlist is a debt you can see; a comment in a review thread is not.
 *
 * WHY THE AST. "A bare catch wrapping a capture primitive" is a STRUCTURAL
 * property — which call sits inside which `try`, and whether that `try`'s
 * handler declares a binding. A regex cannot see scope, and this repo has
 * already paid for four lexical versions of one structural resolver. TypeScript
 * is a dependency and its parser is the same one the compiler uses.
 *
 * THE SUB-SHAPE IN THE SECOND TABLE IS WORSE THAN THE FIRST AND IS SEPARATED FOR
 * THAT REASON. `captureDenseArray` takes a caller-supplied `overflowError`
 * factory and a caller-supplied `captureItem`, so a bare catch there discards
 * not only faults but a DELIBERATE, TYPED signal the caller constructed. Folding
 * those in with the rest would let a reader assume one severity for two
 * different defects.
 */

import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The capture primitives whose refusal must be classified, not swallowed. */
const CAPTURE_PRIMITIVES = new Set([
  "deepCaptureData", "captureOwnDataRecord", "captureExactRecord", "captureDenseArray",
]);

/**
 * Sites that still swallow a capture failure whole. THE LEDGER.
 *
 * Each entry is `file::enclosingSymbol`. Deleting a line is how a migration is
 * recorded; adding one requires a reviewer to agree the debt should grow.
 */
const SWALLOWS_FAULT_AS_REFUSAL: readonly string[] = [
  "src/capability-providers/authority/grants-parse.ts::parseAuthorityProviderPin",
  "src/capability-providers/authority/grants-parse.ts::parseProviderBounds",
  "src/capability-providers/authority/grants-parse.ts::parseProviderGrantState",
  "src/capability-providers/authority/grants-resolve.ts::parseWriteRequest",
  "src/capability-providers/authority/pricing.ts::capturePriceRequest",
  "src/capability-providers/brokers/adapter-capture.ts::opaqueBrokerValues",
  "src/capability-providers/brokers/command.ts::captureArguments",
  "src/capability-providers/brokers/command.ts::capturePayload",
  "src/capability-providers/brokers/effect-state.ts::claimEffectStarted",
  "src/capability-providers/brokers/https.ts::captureHeaders",
  "src/capability-providers/brokers/https.ts::capturePayload",
  "src/capability-providers/brokers/repository.ts::capturePayload",
  "src/capability-providers/brokers/types.ts::parseBrokerEffectReference",
  "src/capability-providers/brokers/types.ts::parseBrokerRequestEnvelope",
  "src/capability-providers/packages/reference-enumeration.ts::referenceObject",
  "src/connectors/candidate-batch.ts::captureConnectorResult",
  "src/preparations/completeness.ts::captureClassInput",
  "src/preparations/completeness.ts::captureIdentitySets",
  "src/preparations/completeness.ts::captureRecord",
  "src/preparations/completeness.ts::compareProviderCompletionClaim",
  "src/preparations/completeness.ts::deriveCompleteness",
  "src/preparations/completeness.ts::toRunCompletionWarning",
  "src/preparations/effects.ts::captureEffectPlan",
  "src/preparations/ephemeral-seal.ts::captureEphemeralPlan",
  "src/preparations/evidence-capture.ts::captureEvidenceRef",
  "src/preparations/intent-compiler.ts::captureDraft",
  "src/preparations/principals.ts::capturePreparationPrincipal",
  "src/preparations/proposals.ts::assertProposalAuthentic",
  "src/preparations/proposals.ts::captureDraft",
  "src/preparations/proposals.ts::captureNormalizeInput",
  "src/preparations/reconciliation.ts::assertDeferPermitted",
  "src/preparations/reconciliation.ts::assertReconciliationAuthentic",
  "src/preparations/reconciliation.ts::assertReconciliationsSettled",
  "src/preparations/reconciliation.ts::captureDecideInput",
  "src/preparations/selection.ts::assertCapturedPolicyContract",
  "src/preparations/selection.ts::assertSelectionDecisionAuthentic",
  "src/preparations/selection.ts::captureSelectionInput",
];

/**
 * The WORSE sub-shape, separated because it is a different defect rather than
 * a different style.
 *
 * `captureDenseArray` takes a caller-supplied `overflowError` factory AND a
 * caller-supplied `captureItem`. A bare catch here therefore discards not only
 * faults but a DELIBERATE, TYPED signal the caller constructed — an overflow it
 * chose to name, or a domain error its item-capturer raised. Folding these in
 * with the rest would let a reader assume one severity for two defects, and
 * these will need a different fix: the caller's own error must pass through,
 * not merely be reclassified.
 */
const SWALLOWS_CALLER_TYPED_SIGNAL: readonly string[] = [
  "src/capability-providers/authority/credentials.ts::assertNoCredentialReflection",
  "src/capability-providers/authority/credentials.ts::createCredentialRegistry",
  "src/capability-providers/brokers/model.ts::capturePayload",
  "src/capability-providers/packages/reference-enumeration.ts::snapshotExternalProviderReferences",
  "src/connectors/confined-fetch-hops.ts::requestPinned",
];

/** Every allowlisted site, in one set. */
const LEDGERED = new Set([...SWALLOWS_FAULT_AS_REFUSAL, ...SWALLOWS_CALLER_TYPED_SIGNAL]);

/** This node's own declared name, when it carries one. */
function declaredName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? null;
  if (ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) {
    return ts.isIdentifier(node.name) ? node.name.text : null;
  }
  return null;
}

/** The nearest named function-ish ancestor, so a site has a stable identity. */
function enclosingSymbol(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    const name = declaredName(current);
    if (name !== null) return name;
  }
  return "<anonymous>";
}

/** True when this try-block calls a capture primitive anywhere inside it. */
function callsCapturePrimitive(block: ts.Node): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && CAPTURE_PRIMITIVES.has(node.expression.text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(block);
  return found;
}

/** Every `.ts` file under `src/`, recursively — `readdir`, as the sibling controls use. */
async function sourceFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(path.relative(REPO_ROOT, full));
  }
  return out;
}

/** Every `file::symbol` whose bare catch wraps a capture primitive. */
async function bareCatchesAroundCaptures(): Promise<string[]> {
  const files = await sourceFiles(path.join(REPO_ROOT, "src"));
  const sites: string[] = [];
  for (const relative of files.sort()) {
    const text = await readFile(path.join(REPO_ROOT, relative), "utf8");
    if (![...CAPTURE_PRIMITIVES].some((name) => text.includes(name))) continue;
    const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
    const walk = (node: ts.Node): void => {
      if (ts.isTryStatement(node) && node.catchClause
        // A BARE catch is one with no binding — `catch {}`. `catch (e)` may still
        // swallow, but it can at least SEE what it caught, and narrowing it is a
        // different edit from this one.
        && node.catchClause.variableDeclaration === undefined
        && callsCapturePrimitive(node.tryBlock)) {
        sites.push(`${relative}::${enclosingSymbol(node)}`);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return sites.sort();
}

describe("no NEW bare catch may swallow a capture failure", () => {
  it("finds no site that is not already ledgered", async () => {
    const found = await bareCatchesAroundCaptures();
    const unledgered = found.filter((site) => !LEDGERED.has(site));
    // NAMED, not counted: a bare count says the invariant broke and not where.
    expect(unledgered).toEqual([]);
  });

  it("keeps the ledger honest — every listed site still exists", async () => {
    // THE OTHER DIRECTION, and it is what stops the list rotting into a
    // permanent exemption nobody re-checks. A migrated site must be DELETED from
    // the ledger, not left behind as a comfortable lie.
    const found = new Set(await bareCatchesAroundCaptures());
    const stale = [...LEDGERED].filter((site) => !found.has(site));
    expect(stale).toEqual([]);
  });

  it("proves the detector actually sees the shape it claims to", async () => {
    // ANTI-VACUITY. An empty result set would satisfy the first case forever.
    // The ledger is non-trivial and every entry was found by this same walk.
    const found = await bareCatchesAroundCaptures();
    expect(found.length).toBeGreaterThan(35);
  });
});
