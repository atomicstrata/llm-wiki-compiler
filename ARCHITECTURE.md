# Compiler, integrations, and products

llmwiki is a knowledge compiler and an authoritative domain-record substrate.
An application can use it without adopting a particular product ontology or
an external workflow engine. The default CLI and default profile remain the
base product, not a hidden installation of AutoSci, Newsroom, or any external
orchestration platform.

## Ownership

| Layer | Responsibility | Source boundary |
| --- | --- | --- |
| Base compiler | Ingest sources, compile and query knowledge, link pages, search, lint, export, and view | Commands and their shared services under `src/` |
| Configurable domain capabilities | Profiles and typed records, relations, retained artifacts, provenance, reviewed mutations, receipts and authority checks | `src/profile`, `artifacts`, `relations`, `trust`, `operation-bundles`, and supporting services |
| Generic effect services | Execute declared product actions and durable preparations under compiler authority | `src/products`, `preparations`, and their SDK facades |
| Optional local workflow engine | Run profile-declared workflows through local invocations with persisted run state: the lightweight tier behind the existing experimental workflow commands and SDK methods | `src/local-workflows`, composed by `src/workflows` and the standard SDK |
| External orchestration | Coordinate a product's overall process, human decisions, revisions, repeated occurrences, and operator workbench | An application's own coordinator, outside this repository |
| Product implementation | Domain policy, providers, editorial/scientific decisions, product-specific UI and export assembly | Product packages or modules outside compiler core |

The word `product` in a compiler service denotes a generic declarative package
and action contract. It does not mean that the service implements Newsroom or
AutoSci. The existing workflow-parent reference verifies a compiler-local run;
it is not a reference to an external coordinator's run and does not delegate
mutation authority to an external engine.

## Integration direction and authority

Applications call the SDK. SDK facades call compiler services. Those services
enforce the active profile, path confinement, grants, reviewed changes, and
artifact verification. Core must not import product implementations or an
external orchestration engine. `test/product-boundary-genericity.test.ts` checks
that direction for statically resolvable TypeScript source imports and instance
identities, plus direct manifest dependencies on known product and engine
packages. The named-package guard is a maintained list, not proof against
computed imports or every possible future package name.

An external coordinator owns the decision to request work. The compiler owns
whether that work is authorized and what was retained or applied. An SDK
preparation grant is not an operation-approval grant. In particular, preparing
a record or invoking a product action does not implicitly approve its bundle;
the separately authorized operator apply path remains necessary.

## Development runtime authority

SDK clients can prepare, observe and retire record effects with explicit grants.
Preparation does not approve or apply a change. Review a proposed manifest with
`llmwiki operation inspect <digest>`; the separate local operator command
`llmwiki product apply <digest>` requires operation-approval authority. An
embedder trusted-write grant does not grant operation approval.

Generic product packs can use `product init`, `preview`, `invoke`, `resume` and
`status`. Provider execution is opt-in through the operator-selected
`LLMWIKI_PROVIDER_INVOCATION_MODULE`; product configuration cannot select trusted
host code on the operator's behalf. Both optional backend packages pin this
development compiler version. The development backend is not a sandbox.

Live workflow projections and retained output/PDF routes are loopback-only.
Providers should use the generic bounded fact panel; the experiment-specific
projection input remains deprecated compatibility, not a core product workflow.
Relation compaction currently refuses operation-bound history rather than
discarding provenance needed for recovery.

## Configuration is not a bundled product application

The built-in `autosci` and `newsroom` profile templates remain available for
compatibility. They describe domain schemas and declarations. They are not the
standalone research/editorial applications and do not install their providers
or orchestrators. Removing the templates would unnecessarily break public
configuration and installation behavior.

Existing experimental compiler-local workflow APIs also remain supported on
their existing terms. They predate the external orchestration split. This
separation does not silently remove them, route them through an external
coordinator, or declare all workflow-related compiler code obsolete.

The two tiers coexist by design and are not a migration path from one to the
other. The local engine is the zero-infrastructure tier: it runs a
profile-declared workflow through local invocations, with mutations serialized
by the project lock and run records retained under `.llmwiki/`. Runs and pending
human gates persist between invocations; one run can span terminal sessions.
Persisted state does not imply automatic replay of interrupted actions.
An application that needs automatic scheduling, worker recovery, distributed
execution, managed approval routing, or coordination across projects should
supply its own coordinator and
call core services; that coordination belongs outside this repository, while
reusable record and authority mechanisms belong here.

### Passive history versus local execution

`src/workflow-history` owns the persisted local-run schema, validation, HMAC
verification, definition lookup, and read-only status projection. It does not
depend on `src/workflows`. Template audits, export checks, parent-reference
verification, linting, and viewer history read this passive layer directly.
The shared trusted-write predicate lives in `src/trust/trusted-write.ts`.

`src/local-workflows` owns local execution and requests effects through an
explicit core host. `src/local-workflow-host` owns confined persistence, signing,
locking and compiler mutation authority. Existing `src/workflows` paths compose
the host or forward to these implementations; they do not duplicate the engine.

### Package composition

Applications, including external coordinators, use `llm-wiki-compiler` as the
supported entry point. The scoped packages below are public installation dependencies, but their
direct exports are internal composition contracts rather than separately
supported application APIs. Contributors work in one repository with root-level
workspace installation and ordered builds; no package publication is needed locally.

- `@atomicstrata/llmwiki-core` provides `createWikiCore`, knowledge/domain services, passive
  history, and explicit host contracts. It has no local-engine dependency or
  workflow-execution SDK methods.
- `@atomicstrata/llmwiki-local-workflows` provides the engine and requires a matching core peer.
  It requires a host at construction; it cannot manufacture default authority.
- `llm-wiki-compiler` remains the standard CLI and `createWiki` SDK. Both packages
  are required exact-version dependencies, preserving existing workflow features.
  Engine-free composition is an internal implementation capability, not a
  separately supported consumer installation path.

Core entry points share built chunks, including lock/error identities and a
module-instance token. Composition rejects a host from a duplicate core instance.
The standard package's `compiler-sdk` and `compiler-cli` support entries preserve
its composition without bundling another private copy of core. The separately
named `compiler-legacy-workflows` entry preserves the caller-held-lock start
contract; it does not independently verify that the caller holds the lock.

The build orders core, engine, and standard facade. `npm run dev` explicitly
watches shared sources and rebuilds the dependencies before CLI success. Installed
CLI/SDK and core-only smoke checks are separate from source-boundary checks;
full product parity and public-release approval remain integration requirements.

### Package analysis conventions

Core's source still lives under the root `src/` tree. Fallow attributes those
imports to the root workspace, so its core-manifest dependency findings are not
meaningful. Only `packages/llmwiki-core/package.json` is excluded from Fallow;
`test/local-workflow-package-boundary.test.ts` instead compares its dependency
declarations exactly against imports in built JavaScript and declarations.
Root dependency analysis and all core source analysis remain enabled.

Package entries and retained `src/workflows` compatibility paths are explicit
analysis entry points. Named duplicate-export exceptions identify forwarding
aliases, not duplicate implementations. Do not remove compatibility exports to
make the dead-code report green.

## Viewer extension boundary

The generic viewer consumes a bounded, verified projection. New providers use
the product-neutral `factPanel` contract; labels and values remain text, with
closed presentation tones. A provider contributes facts, not markup or mutation
authority. Verification failures degrade the display to recorded-only.

The older `experimentState` wire field and `VerifiedExperimentStateV1` type are
retained for existing consumers. Their scientific validation lives in
`src/viewer/compat/experiment-state.ts`, and their presentation lives in
`src/viewer/assets/viewer-experiment-compat.js`. The generic stage-fact renderer
does not interpret hypotheses or scientific verdicts. This is a bounded
compatibility exception, not a pattern for adding product-specific fields.

## Deciding where a new feature belongs

- Keep mechanisms that work across ontologies in the compiler: record contracts,
  retained bytes, evidence references, confinement, verification, and authorized
  mutation.
- Put process sequencing, revision strategy, and human interaction in the
  application's own coordinator when the local engine's invocation-driven scope
  is not enough.
- Put domain judgments and provider implementations in product or reusable
  external modules. A compiler profile may declare their data contracts without
  importing their implementation.
- Preserve existing public behavior and API names during structural cleanup.
  Removing a compatibility surface or moving its authority is a separate,
  explicitly reviewed compatibility decision.
