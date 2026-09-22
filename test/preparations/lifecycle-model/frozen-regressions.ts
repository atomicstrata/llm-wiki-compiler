/**
 * @file test/preparations/lifecycle-model/frozen-regressions.ts
 * @description The immutable inventory of the Task 9 regression corpus at the design
 * baseline: every scenario's id, title and body digest, plus a digest of each whole
 * corpus FILE.
 *
 * Both layers are needed. Body digests catch an assertion being replaced inside a
 * scenario; the whole-file digest catches the same weakening moved somewhere a scenario
 * body never appears — a shared helper, a custom matcher, or `lifecycle-fixture.ts`,
 * which owns no scenario of its own yet is what most of the corpus asserts through.
 *
 * A slice that legitimately changes a corpus file must update this manifest, which is
 * exactly the explicit disposition the migration requires. The friction is the feature.
 *
 * RE-BASELINED 2026-09-21 for reviewed CI deduplication: RST-009 delegates its
 * completed-sweep assertion to lifecycle-fixture.ts. PRN-006/007/008 delegate the
 * identical authenticated resume request to resumePrune; their refusal, retained
 * bytes and completion assertions stay in place. PRN-009 delegates setup and the
 * afterDeletes crash to stageAndCrashPrune, whose rejection assertion now checks
 * the crash message as well. Only these five body hashes and the whole-file
 * hashes for key-reset.test.ts, prune-sweep.test.ts and lifecycle-fixture.ts move.
 * The shared fixture is itself frozen. IDs, titles, counts, classification and
 * production-entry-point obligations remain unchanged; no attack is removed.
 *
 * RE-BASELINED 2026-09-19 for test typing only: key-reset helper arguments now
 * use PreparationRunId; the shared actor id is mutable string-typed for capture
 * probes; QTN-009 omits the unused runId from its evidence-location argument.
 * Only those three whole-file hashes and QTN-009's body hash changed. No assertion,
 * scenario identity, classification, or production reach was removed or weakened.
 *
 * RE-BASELINED 2026-08-08 by the prune/sweep surface slice, and here is the whole of
 * what moved, so the diff is reviewable as a claim rather than as a hash churn:
 *
 *  - 13 scenario bodies across `prune-sweep.test.ts`, `key-reset.test.ts` and
 *    `lifecycle-races.test.ts`, plus the whole-file digests of those three and of
 *    `lifecycle-fixture.ts` and `authority-references.test.ts`.
 *  - EVERY change is a CALL SHAPE or a STRENGTHENING. Prune's request now names its
 *    target through a discriminant (`{kind: "run", binding}`) because a crashed prune
 *    has already destroyed the binding a resume would need; sweep's request carries
 *    the unit the gate authorized (`expectedUnitId`); sweep returns a discriminated
 *    outcome instead of a `null` that meant both "nothing to do" and "cannot tell";
 *    and the lifecycle projection's pending arm is `pending` carrying each unit's
 *    OPERATION rather than a hardcoded `quarantine-pending` label.
 *  - NOT ONE assertion was removed or weakened. `toBeNull()` became an exact status,
 *    and TWO of the pending-state checks now assert the operation that owns the unit
 *    rather than only that something was pending.
 *  - Stated precisely, because the first version of this note overclaimed the second
 *    one: PLA-REG-PRN-016 and the `authority-references` helper moved
 *    `"quarantine-pending"` to `"pending"` and stopped there. That is the rename
 *    following the projection, not a strengthening — no weakening either, but the
 *    distinction is the whole value of a note a reviewer is meant to trust.
 *
 * RE-BASELINED 2026-08-09 by the gate/executor re-authorization fix, and here is
 * the whole of what moved so the diff reads as a claim rather than hash churn:
 *
 *  - 11 scenario bodies (PLA-REG-PRN-003/004/006/007/008/009/010/012/013/014 and
 *    PLA-REG-RST-009), plus the whole-file digests of `prune-sweep.test.ts`,
 *    `key-reset.test.ts` and `lifecycle-fixture.ts`.
 *  - EVERY change is a CALL SHAPE or a REFUSAL THAT MOVED LAYER, and none is a
 *    weakening. Two shapes account for all of them:
 *
 *    1. Each destructive call now NAMES THE GATE DECISION IT ACTS UNDER. The
 *       authorization travels with the request, so a call site must say whether
 *       it is a fresh start or a resume and which unit it targets. Four sites
 *       previously passed no target at all — which the gate refuses outright, so
 *       they were asserting against a decision the gate would never issue.
 *    2. Four refusals now arrive from the GATE'S OWN PREDICATE, re-run by the
 *       driver over its own capture, one layer before the executor's specific
 *       check. The drifted-target and symlinked-unit cases and the two
 *       lost-receipt sweep cases each refuse earlier and for a reason the gate
 *       states; every one still REFUSES and still deletes nothing, which is the
 *       property each case exists for.
 *
 *  - NOT ONE assertion was removed, and none was retargeted at whatever error
 *    happened to appear. Each new expectation traces to a NAMED refusal in the
 *    gate's predicate; the drifted-target case was additionally probed directly
 *    (the unit moves from `operation:"run-prune", complete:true` to
 *    `operation:null, complete:false, problemRegistries:["prune"]`, so the drift
 *    genuinely destroys the unit's provenance and no verb owns it).
 *  - STATED PRECISELY, because it is a real narrowing a reader should not have to
 *    infer: three of those four cases now assert a LESS SPECIFIC operator
 *    message than before — the gate's reason rather than the executor's. That is
 *    a consequence of moving authorization earlier, not an improvement, and it is
 *    on the pull request as such.
 *  - `lifecycle-fixture.ts` moved only in its crashed-prune helper, which now
 *    derives its target instead of omitting it. No assertion in it changed.
 */

/**
 * The one production driver each destructive operation is exercised through. A case
 * claiming an operation must reach THAT operation's driver, which is what makes the
 * classification checkable rather than a label anyone can retype.
 */
export const OPERATION_DRIVERS = {
  quarantine: "quarantinePreparationRunLocked",
  reset: "resetPreparationKeyEpochLocked",
  prune: "prunePreparationRunLocked",
  sweep: "sweepPreparationOrphansLocked",
  purge: "purgeQuarantineUnitLocked",
} as const;

/**
 * Digest of every case's REVIEWED classification: id, operation, evidence, and entry
 * point, in corpus order.
 *
 * The other classification checks are static, and static reach cannot decide the one
 * question that matters here — whether a call is the scenario's SUBJECT or merely its
 * SETUP. Three rounds were spent trying to infer that: each new inference rule was
 * satisfiable by relabelling a case to some other category it also touches, because
 * nearly every scenario legitimately calls a consumer, a driver, and a helper. The
 * judgement is human, so the durable control is to freeze the judgement itself and make
 * any change to it an explicit, reviewed edit. The allowlist, reach, and cross-authority
 * checks remain as sanity checks on top of this — they catch nonsense, not intent.
 *
 * SCOPE, stated exactly: this does NOT prevent a wrong classification. A reviewer who
 * changes a record and re-baselines this digest in the same commit is trusted, and I
 * verified that path passes. What it removes is the SILENT reclassification — the one
 * that rides through on whichever static check is weakest, which is how every previous
 * label defect in this corpus arrived. It converts an inference problem nothing can
 * solve into a diff a human must look at.
 */
export const FROZEN_CLASSIFICATION_DIGEST =
  "170b28e84f136b595add7643cbf9fee71cb77f0b8dedee307b0e4fcc77e7917e";

/**
 * The closed set of entry points a `shared` case may name. `shared` exempts a record
 * from both cross-authority checks, so it has to MEAN something: a case that genuinely
 * exercises a cross-cutting consumer or a shared filesystem primitive, rather than any
 * scenario that happens to call a non-driver export. Without this, relabelling an
 * ambiguous case to `shared` plus a path helper escaped every control at once.
 */
export const SHARED_CONSUMER_ENTRY_POINTS = [
  "enumeratePreparationReferences", // reference completeness
  "resolvePreparationLifecyclePending", // the lifecycle mutation gate
  "scanPreparationInventory", // capacity accounting
  "abandonPreparationRunLocked", // abandonment, cross-cutting w.r.t. the destructive five
  "pruneEligibility", // the eligibility predicate
  "deriveResidualFindings", // residual obligation computation
  "lstatLeaf", // shared presence primitive: absent vs unavailable
  "readDirectoryNames", // shared listing primitive
] as const;

/** Which destructive lifecycle operation a frozen case belongs to. */
export const FROZEN_OPERATIONS = ["quarantine", "reset", "prune", "sweep", "purge", "shared"] as const;

/** What KIND of evidence a frozen case is, so the corpus's composition is auditable. */
export const FROZEN_EVIDENCE_CLASSES = ["adversarial", "ordinary", "durability", "compatibility"] as const;

/** The commit whose corpus this manifest freezes. */
export const FROZEN_REGRESSION_BASELINE = "4499a7dc8465f5b1eff75e8587477454570c2fc2";

/** Every file in the frozen Task 9 corpus, derived from the baseline itself. */
export const FROZEN_REGRESSIONS = [
  {
    path: "test/preparations/abandonment.test.ts",
    fileSha256: "8d1a0170576ee4556a74c08008d7703724499e2469cacbff94dd0be7c722c60d",
    scenarios: [
      { id: "PLA-REG-ABD-001", title: "terminates a confirmed recovery-required run as abandoned", bodySha256: "778ba5c8d6ea1bd8cc9fcc3b5e904509254eee2170d913773d3f463180013096", operation: "shared", evidence: "ordinary", reachesProduction: "abandonPreparationRunLocked" },
      { id: "PLA-REG-ABD-002", title: "fails closed without explicit residual-state confirmation", bodySha256: "ad21df2e560a95aeb840a089cc531ecc2673dc5fdf8f7bf542aa2707ad47ce1d", operation: "shared", evidence: "adversarial", reachesProduction: "abandonPreparationRunLocked" },
      { id: "PLA-REG-ABD-003", title: "refuses to abandon a run that is not recovery-required", bodySha256: "379e481cbfa459d76c9e8dd9031a9ca94f2668a5f10552d0d1d19f4dfe7731ad", operation: "shared", evidence: "adversarial", reachesProduction: "abandonPreparationRunLocked" },
      { id: "PLA-REG-ABD-004", title: "refuses to abandon an integrity-invalid run", bodySha256: "aebd860337ea591963322ce7c6d5b5dd92c0db4a2e947bec9b60e9abd316cf03", operation: "shared", evidence: "adversarial", reachesProduction: "abandonPreparationRunLocked" },
      { id: "PLA-REG-ABD-005", title: "recomputes every unsettled phase, checkpoint, effect, and broker obligation", bodySha256: "105310d5ac41ca5e85872d5918133c14842be9fee1733c9eaec05ec2ca151f2b", operation: "shared", evidence: "ordinary", reachesProduction: "deriveResidualFindings" },
    ],
  },
  {
    path: "test/preparations/authority-references.test.ts",
    fileSha256: "98d0ce7c33c2825ebfb1b75602f410917881c0547ec1487962c4a08c5193ba2f",
    scenarios: [
      { id: "PLA-REG-REF-001", title: "emits runtime-authority and product-package references for a nonterminal run", bodySha256: "5ff318940ed905ee3f448071f4f36aa3532c177c48f431f04d21dad6fa41c253", operation: "shared", evidence: "ordinary", reachesProduction: "enumeratePreparationReferences" },
      { id: "PLA-REG-REF-002", title: "reports a retained terminal and an abandoned run by their exact state", bodySha256: "1dba25686690889192bfb27a0a5bc446e7e32ef328057b2123f593e9ad047607", operation: "shared", evidence: "ordinary", reachesProduction: "enumeratePreparationReferences" },
      { id: "PLA-REG-REF-003", title: "reports a handed-off run with its bound bundle id", bodySha256: "b51565e513769d54b4141ef51a67f30053ee64506db6f81099bc26e5c86554c7", operation: "shared", evidence: "ordinary", reachesProduction: "enumeratePreparationReferences" },
      { id: "PLA-REG-REF-004", title: "fails closed on an integrity-invalid owner", bodySha256: "a3228a36819e35eac4d181dc5976dc1f1ed60274f4b0abdc71c171de044c6c9e", operation: "shared", evidence: "adversarial", reachesProduction: "enumeratePreparationReferences" },
      { id: "PLA-REG-REF-005", title: "fails closed while a destructive quarantine unit is pending", bodySha256: "0e841c5c8f8e184e57faff20b1f32110b81b366b9ce75c3400a733d6c5615027", operation: "shared", evidence: "adversarial", reachesProduction: "enumeratePreparationReferences" },
      { id: "PLA-REG-REF-006", title: "enumerates concurrent preparations in deterministic order", bodySha256: "9a06eb9f9d403d0bbe7e7e206f2f5be0ac0124e8ea9875bf7c92981311020057", operation: "shared", evidence: "compatibility", reachesProduction: "abandonPreparationRunLocked" },
      { id: "PLA-REG-REF-007", title: "a deleted planned receipt stays pending, never silently settled", bodySha256: "c5810390df5a34389c9a20b6953f4c8feb894dc208ef51f27c64a2b631d38601", operation: "shared", evidence: "adversarial", reachesProduction: "enumeratePreparationReferences" },
      { id: "PLA-REG-REF-008", title: "a corrupted planned receipt stays pending, never silently historical", bodySha256: "50c1a9aebfac575036b2b358f8e7a71e531c814090898d1ee3a7b4aeb63d9bbb", operation: "shared", evidence: "adversarial", reachesProduction: "enumeratePreparationReferences" },
      { id: "PLA-REG-REF-009", title: "an unreadable unit or registry reads unavailable, never clean", bodySha256: "89538aa47fcae50519f60b4a01eaac8166fcb8402a36766a9570756c0155d5ed", operation: "shared", evidence: "adversarial", reachesProduction: "enumeratePreparationReferences" },
      { id: "PLA-REG-REF-010", title: "a resumed quarantine refuses to move a source that changed since the plan", bodySha256: "bdd128e2eac44193415f8434fcb2d0c34c2b48121567f22bb8dca98d6533c5df", operation: "quarantine", evidence: "durability", reachesProduction: "quarantinePreparationRunLocked" },
      { id: "PLA-REG-REF-011", title: "a unit replaced by a symlink reads unavailable, never clean", bodySha256: "ce4e59a04be8a5df167d92b1381b0bb649c52c31c914f796f5b66603867038c6", operation: "shared", evidence: "adversarial", reachesProduction: "enumeratePreparationReferences" },
      { id: "PLA-REG-REF-012", title: "a registry root replaced by a symlink reads unavailable, never clean", bodySha256: "6a08d133a55139b94d00a0d87d1da4db159250c0fb34ddd2821bce63d48d614f", operation: "shared", evidence: "adversarial", reachesProduction: "enumeratePreparationReferences" },
      { id: "PLA-REG-REF-013", title: "a unit retired by a completed reset reads historical, so references stay complete", bodySha256: "237d169ce6623b2a19fa0eb38f3c0a04883fec5a1db7772d0d3d7cbd7c24fafc", operation: "shared", evidence: "ordinary", reachesProduction: "enumeratePreparationReferences" },
      { id: "PLA-REG-REF-014", title: "a resumed reset signs the planned retirement digests, not a re-enumeration", bodySha256: "7476ea9e7466ba33c31eaea89bb5e1ad89cb672ded14b1502b26084745a52d08", operation: "reset", evidence: "durability", reachesProduction: "resetPreparationKeyEpochLocked" },
    ],
  },
  {
    path: "test/preparations/key-reset.test.ts",
    fileSha256: "0f606ffc12b22ff092f94ea22f18afcf7713d9fdb8f73e4f1bab5d1b77cc2fc8",
    scenarios: [
      { id: "PLA-REG-RST-001", title: "records an intent and returns a continuation secret on the first pass", bodySha256: "051ac05936034d5cd2184dec5cf82bd70939be1d5a06cef2f8085e60e65f313d", operation: "reset", evidence: "ordinary", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-002", title: "quarantines all authority and installs one fresh epoch on the token-bearing rerun", bodySha256: "b874356ad9606d29189939791d5e53a1855ad116f972d5ae41c4c2e307493ab7", operation: "reset", evidence: "durability", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-003", title: "refuses a second bare pass rather than leaving two pending intents", bodySha256: "13faafdeb59ed3db40c2817ebf819712a027286fa1e4ec47058516c22a5eca8c", operation: "reset", evidence: "adversarial", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-004", title: "supersedes a pending intent only when explicitly asked, invalidating its token", bodySha256: "1985ac3fef2b11992a18e39813f08d100fee6f0f8554bac1a69b1abde3f15a2f", operation: "reset", evidence: "ordinary", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-005", title: "refuses a malformed or unmatched continuation token", bodySha256: "994ca76ce61c1ead212f4fc6df3a97cec59a8c5c81b7f977fd03d31eb938e752", operation: "reset", evidence: "adversarial", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-006", title: "refuses the ordinary reset when the key is unreadable, not missing", bodySha256: "d65b2d314300398ac14fb442063647d6e98953ef6e3b8505f605cd7668225c6a", operation: "reset", evidence: "adversarial", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-007", title: "refuses to reset a healthy key epoch", bodySha256: "967bdc7f779dcc578bceaaab406d93eedf6fc328f57c4d86f5d76a49a948becc", operation: "reset", evidence: "adversarial", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-008", title: "removes the plaintext staged key and the intent marker once the reset completes", bodySha256: "3e0e19b82f4622c8f712bdd74c9943f62a2f51515ce801161fa5e712af17b22b", operation: "reset", evidence: "ordinary", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-009", title: "takes custody of sweep bytes staged under the epoch it replaces", bodySha256: "ba59d3768d69a66aef8d05093f34c509ebdc1e2a3dbd2afedf3b4b8d93bebfb8", operation: "reset", evidence: "ordinary", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-010", title: "refuses the reset when a prune unit is an empty symlink rather than a real directory", bodySha256: "2bf2fac389b8214f826e187403d659e30070ea3da4dbdc8b9b3d9ba477d54111", operation: "reset", evidence: "adversarial", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-011", title: "stages a fresh durable preparation after a completed reset", bodySha256: "e59c880bf96cf8fb47dbaaedd5199f96b37f4658804dce56c5a8b277c5e6023b", operation: "reset", evidence: "durability", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-012", title: "records intent instead of completing when a full reset unit is planted and the key is absent", bodySha256: "ee1a82722da37dd2e88532d39481fffc289aefec671e055a8cdd491a7023eee0", operation: "reset", evidence: "adversarial", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-013", title: "refuses a planted reset-intent while the key is healthy and quarantines nothing", bodySha256: "8b37a8634acae3d941d88d2a9c57c06a46edba9e9e207d571024ee3334300201", operation: "reset", evidence: "adversarial", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-014", title: "refuses a token-bearing rerun when the key is restored between the two invocations", bodySha256: "dcbe4136b8d8a04102defe095227030e6dd04802aa14bd43c11e288cf2e93947", operation: "reset", evidence: "durability", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-015", title: "refuses a token whose intent was copied into another unit", bodySha256: "9f6b94f9f5c31b44b6d7cc968098678477d8a3f325c940aefca5659d23ff216e", operation: "reset", evidence: "adversarial", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-016", title: "refuses a signed planned receipt copied over the completed receipt name", bodySha256: "eaa621481b10e6a3043a7751a5125e49e4842f042a73cf017a27e54173e28201", operation: "reset", evidence: "adversarial", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-017", title: "refuses a new intent when an existing unit is unreadable rather than assuming none", bodySha256: "8104f285a92aaa6ea567795b7e4c7aae4cd3c77b48f2b556fd594dc89df69d26", operation: "reset", evidence: "adversarial", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-018", title: "resumes a reset that crashed after publishing the active key and completes", bodySha256: "af6291dc062eb271fa58c2c3f0b6bb7fefb2277297b1a3002349d1f496641e98", operation: "reset", evidence: "durability", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-019", title: "resumes a reset that crashed after staging the pending key and completes", bodySha256: "c866ca81a0f559ed7c65bba246a02a5f45edcb42bea0e1ffa8b36ab97a5cbd64", operation: "reset", evidence: "durability", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RST-020", title: "moves the unreadable key into quarantine before minting a fresh epoch", bodySha256: "2ec6bc322c82db0373138041b8fc5cd03f6af283d7f98360a9974f09e370c500", operation: "reset", evidence: "adversarial", reachesProduction: "resetPreparationKeyEpochLocked" },
    ],
  },
  {
    path: "test/preparations/lifecycle-fixture.ts",
    fileSha256: "9fa999bb5447cdc520aea41c988a0dbda9334bc09b59bfb15c2109246705f39e",
    scenarios: [

    ],
  },
  {
    path: "test/preparations/lifecycle-races.test.ts",
    fileSha256: "b9823eb271c11ea1a59fe1ae1fd53ac98dfb15678457b7220945dde5201935d1",
    scenarios: [
      { id: "PLA-REG-RACE-001", title: "resumes after a crash following the planned receipt without byte loss", bodySha256: "3ea7c682ad81b8178a1869f4c6be05a1634a4bf6c94f90d22e6ef3394eb725a0", operation: "quarantine", evidence: "durability", reachesProduction: "quarantinePreparationRunLocked" },
      { id: "PLA-REG-RACE-002", title: "resumes after a crash following the moves and never re-trusts the run", bodySha256: "cdb5c3b3155d5424311e1a5d6dc9fdf9b8bb42a3061c89bcf1cc876b71e48708", operation: "quarantine", evidence: "durability", reachesProduction: "quarantinePreparationRunLocked" },
      { id: "PLA-REG-RACE-003", title: "reuses a fresh key minted before a crash and completes on the rerun", bodySha256: "7e9c36c937217fd3999ba5a1c94cb91e978d9ad1c6303823767e33dbd6860052", operation: "reset", evidence: "durability", reachesProduction: "resetPreparationKeyEpochLocked" },
      { id: "PLA-REG-RACE-004", title: "moves every scoped byte exactly once across a mid-move crash", bodySha256: "a1ed2aeba58a22462e85bcd278228f0f9fb706662dfcf9616662ea7042f65ff3", operation: "reset", evidence: "durability", reachesProduction: "resetPreparationKeyEpochLocked" },
    ],
  },
  {
    path: "test/preparations/prune-sweep.test.ts",
    fileSha256: "9eba0b408d72c2dd408e695b4fc82509c99fa5e6d87ed3aa3452610a39ed347b",
    scenarios: [
      { id: "PLA-REG-PRN-001", title: "is eligible only for a terminal run past the injectable retention floor", bodySha256: "4d2bccbf78d416a069379014ab7a961fe7b806a420da22ddd59daac2e5ddb677", operation: "shared", evidence: "ordinary", reachesProduction: "pruneEligibility" },
      { id: "PLA-REG-PRN-002", title: "is never eligible for a recovery-required run", bodySha256: "cbc5b2c182bc88806cd2be3ed1b31c7e5778ee94de58febf9a4336e6644e2a95", operation: "shared", evidence: "adversarial", reachesProduction: "pruneEligibility" },
      { id: "PLA-REG-PRN-003", title: "deletes an eligible run's exact bytes and keeps a tombstone", bodySha256: "44754842ea003bd5a45eb5f67fa34a642389781c68a7a79358a9efea24684973", operation: "prune", evidence: "ordinary", reachesProduction: "prunePreparationRunLocked" },
      { id: "PLA-REG-PRN-004", title: "refuses to prune a run still within the retention floor", bodySha256: "9e7f5a8fb04f8c330c11205733f756449fcedcb83529c3a58dc9a2be0ab820eb", operation: "prune", evidence: "adversarial", reachesProduction: "prunePreparationRunLocked" },
      { id: "PLA-REG-PRN-005", title: "refuses a fresh prune whose target changed after the plan became durable", bodySha256: "264e0f3dd617fb643f3bf18ba7ed101a8b57c45a3d71fc7840b43538159162e5", operation: "prune", evidence: "durability", reachesProduction: "prunePreparationRunLocked" },
      { id: "PLA-REG-PRN-006", title: "refuses to delete a target whose bytes changed since the plan", bodySha256: "140cdb3e3e645e243296dcbc34b1766740710942718ff9c776802ef905be6f97", operation: "prune", evidence: "adversarial", reachesProduction: "prunePreparationRunLocked" },
      { id: "PLA-REG-PRN-007", title: "resumes a prune that crashed between staging and unlinking, leaving no staged bytes", bodySha256: "10a021a2ab77a206d9345f4335d28a5f194ca3801212a056e88ec9f096ec778f", operation: "prune", evidence: "durability", reachesProduction: "prunePreparationRunLocked" },
      { id: "PLA-REG-PRN-008", title: "refuses to stage into a prune unit replaced by a symlink out of the project", bodySha256: "fa4f23cb48e45cb2c447e9d5b8cc39afe5f1d4faadac35e5c23f5a3e0406a6cf", operation: "prune", evidence: "adversarial", reachesProduction: "prunePreparationRunLocked" },
      { id: "PLA-REG-PRN-009", title: "resumes a prune interrupted after the deletes", bodySha256: "5470a21f016d7fc038abb13dc0801bbd7c92e7a610de660af14cd527c7010289", operation: "prune", evidence: "durability", reachesProduction: "prunePreparationRunLocked" },
      { id: "PLA-REG-PRN-010", title: "refuses to sweep from a partial inventory instead of deleting what it can see", bodySha256: "1871439db54148f96e96701885916cb09fc6e037b7cb3c4d271491e10276a49d", operation: "sweep", evidence: "adversarial", reachesProduction: "sweepPreparationOrphansLocked" },
      { id: "PLA-REG-PRN-011", title: "reclaims a manifest whose run leaf is provably absent", bodySha256: "0ba25a6e10697034960146a42e905158b3a577ed36baec12a885dce3aa5791c3", operation: "sweep", evidence: "ordinary", reachesProduction: "sweepPreparationOrphansLocked" },
      { id: "PLA-REG-PRN-012", title: "resumes its own pending unit after a staging crash instead of deriving a new one", bodySha256: "befcb766a30228f5684b44a054d98e3e7d3387bdee26cc7abc5529f76e7f0ce4", operation: "sweep", evidence: "durability", reachesProduction: "sweepPreparationOrphansLocked" },
      { id: "PLA-REG-PRN-013", title: "refuses to derive a new sweep when staged bytes have lost their planned receipt", bodySha256: "4700b0ad87af3ce2902386c7f476905496e8fafddc5d5f393655f9e95af93165", operation: "sweep", evidence: "adversarial", reachesProduction: "sweepPreparationOrphansLocked" },
      { id: "PLA-REG-PRN-014", title: "refuses a renamed staged leaf just as it refuses a prefixed one", bodySha256: "150453bf3fed353865e5ea0763bcd99eafb317db40bccfd44a5d437295ce70de", operation: "sweep", evidence: "adversarial", reachesProduction: "sweepPreparationOrphansLocked" },
      { id: "PLA-REG-PRN-015", title: "refuses to derive a sweep when the prune registry root is a symlink", bodySha256: "723a90ea9cc0eead60e78dd1065e18d92abc8bc8ff820eeb8f312459e3e84e17", operation: "sweep", evidence: "adversarial", reachesProduction: "sweepPreparationOrphansLocked" },
      { id: "PLA-REG-PRN-016", title: "a crashed sweep is visible to the lifecycle gate and blocks reference completeness", bodySha256: "6684e6289d87863f0933abc4987d66889767bcf4bac3e762fe900b5a7a0fd132", operation: "shared", evidence: "durability", reachesProduction: "enumeratePreparationReferences" },
      { id: "PLA-REG-PRN-017", title: "never sweeps an integrity-invalid run whose owner is unreadable", bodySha256: "38433c5d65325de82c5b18d426d9399abe2f00441702a4606f787062810fa11a", operation: "sweep", evidence: "adversarial", reachesProduction: "sweepPreparationOrphansLocked" },
    ],
  },
  {
    path: "test/preparations/quarantine.test.ts",
    fileSha256: "766a4815dda86639f25b217095a5388190a772f7a204a2a0b7c57a08c7fea982",
    scenarios: [
      { id: "PLA-REG-QTN-001", title: "moves an integrity-invalid run byte-for-byte and stops counting it as active", bodySha256: "39b3133c2fefa28981e2b1919d9cbebc227c92370997df333dfd79c7d80a5eca", operation: "quarantine", evidence: "ordinary", reachesProduction: "quarantinePreparationRunLocked" },
      { id: "PLA-REG-QTN-002", title: "is idempotent: a re-run resumes the same unit and returns the same objects", bodySha256: "544011045126b1d38218f8eb96cb15a0e169c6f0af3e03100afa3e39205ec0d3", operation: "quarantine", evidence: "durability", reachesProduction: "quarantinePreparationRunLocked" },
      { id: "PLA-REG-QTN-003", title: "refuses a valid run, a missing confirmation, and a missing key", bodySha256: "c44ecd0de9ebe5995c5dbdbeaf1a58e620f80cefd8e36febd292b141bf052f47", operation: "quarantine", evidence: "adversarial", reachesProduction: "quarantinePreparationRunLocked" },
      { id: "PLA-REG-QTN-004", title: "destroys only a complete unit's bytes and retains the receipt tombstone", bodySha256: "29357abbc76d06fc641e25ec24060972ddbb1b35ed29e416bc59bb256790238b", operation: "purge", evidence: "ordinary", reachesProduction: "purgeQuarantineUnitLocked" },
      { id: "PLA-REG-QTN-005", title: "refuses a purge without the destroy confirmation", bodySha256: "af48064973be3a878c36188bd1796b76ffd1bc2b314bf52f41440536bc9c041d", operation: "purge", evidence: "adversarial", reachesProduction: "purgeQuarantineUnitLocked" },
      { id: "PLA-REG-QTN-006", title: "refuses to purge an incomplete unit", bodySha256: "2ee5a07d6c993f80bff8d08ec10f3a4602befdfe048533e2a6933e52413ce181", operation: "purge", evidence: "adversarial", reachesProduction: "purgeQuarantineUnitLocked" },
      { id: "PLA-REG-QTN-007", title: "refuses a fresh plan whose source changed after the plan became durable", bodySha256: "d5a417168643eea015a26a43c6b21954c2abe759b0bd3948dc2df53d8983525d", operation: "quarantine", evidence: "durability", reachesProduction: "quarantinePreparationRunLocked" },
      { id: "PLA-REG-QTN-008", title: "refuses to complete when planned bytes sit at the destination beside a live source", bodySha256: "f0b9a6cd9a7d9cf9c61cc8a811ed8873088852ab66624d38cca11f700747019b", operation: "quarantine", evidence: "adversarial", reachesProduction: "quarantinePreparationRunLocked" },
      { id: "PLA-REG-QTN-009", title: "quarantines evidence larger than the old private hash ceiling", bodySha256: "1d24633a1d1b70f0b8008b874d9bf50d0e5328a154a1bb6870ac445e362960ce", operation: "quarantine", evidence: "adversarial", reachesProduction: "quarantinePreparationRunLocked" },
      { id: "PLA-REG-QTN-010", title: "completes a commit interrupted after the link but before the source unlink", bodySha256: "4f65a16a322b93c2a33373ba5c1801a1b9b83f8157173207a1495982f1fad27e", operation: "quarantine", evidence: "ordinary", reachesProduction: "quarantinePreparationRunLocked" },
      { id: "PLA-REG-QTN-011", title: "refuses to plan a destructive scope from an incomplete inventory", bodySha256: "ac13e72cf7766f93f97976d62f0332f433ae0bdb51ccd9aedb8fd6d6c8c6c2ef", operation: "quarantine", evidence: "adversarial", reachesProduction: "quarantinePreparationRunLocked" },
      { id: "PLA-REG-QTN-012", title: "refuses to purge through a unit symlinked out of the project, deleting nothing", bodySha256: "5839a69d4403ca99ad84449bb86ae14dfa98db9bee587fbe6fc464b64b424cbf", operation: "purge", evidence: "adversarial", reachesProduction: "purgeQuarantineUnitLocked" },
      { id: "PLA-REG-QTN-013", title: "refuses to purge on a signed planned receipt copied over the completed name", bodySha256: "585594ef89280e9dcc7700987fe81e65bb61c458fdd8a5e6dab5f62c2bf3fd10", operation: "purge", evidence: "adversarial", reachesProduction: "purgeQuarantineUnitLocked" },
    ],
  },
  {
    path: "test/utils/fs-presence.test.ts",
    fileSha256: "5066c263df4e81d44dfd93c9122a20017acebb98d852e97a73967cd1f03fe41e",
    scenarios: [
      { id: "PLA-REG-PRS-001", title: "proves absence only on ENOENT and reports every other fault as unavailable", bodySha256: "28de58f01af800b1be18e6db7811aa18cbc20da6af229f793d23724d555d113a", operation: "shared", evidence: "adversarial", reachesProduction: "lstatLeaf" },
      { id: "PLA-REG-PRS-002", title: "distinguishes an absent directory from an unreadable one", bodySha256: "9d67ea790855630e648047a657d234d42c6ba16390427eac444b4b1c1ec2d5bd", operation: "shared", evidence: "adversarial", reachesProduction: "readDirectoryNames" },
    ],
  },
] as const;

/** Total scenarios frozen at the baseline; a later corpus may exceed it, never fall below. */
export const FROZEN_REGRESSION_SCENARIO_COUNT = 75;

/** Every frozen scenario id, for coverage rows that cite historical evidence. */
export const FROZEN_REGRESSION_IDS: readonly string[] =
  FROZEN_REGRESSIONS.flatMap((file) => file.scenarios.map((scenario) => scenario.id));
