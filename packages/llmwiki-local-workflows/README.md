# @atomicstrata/llmwiki-local-workflows

The optional compiler-local workflow engine. This preserves llmwiki's existing
workflow semantics; it is not llmflow or an alternative external orchestrator.

This publicly downloadable supporting package is not a separately supported
consumer API. The following composition example is for compiler maintainers:

```js
import { createLocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-host";
import { createLocalWorkflowRuntime } from "@atomicstrata/llmwiki-local-workflows";
const runtime = createLocalWorkflowRuntime(createLocalWorkflowHost());
```

Install the exact matching `@atomicstrata/llmwiki-core` peer. The engine requires an explicit
host and rejects a host from another core instance. Core retains persistence,
locking and mutation authority; the engine requests effects through that host.
Constructing the engine does not grant approval or trusted-write permission.

These low-level integration exports assume trusted in-process callers; they are
not a sandbox for plugins. In particular, a caller can supply a human actor to a
low-level gate operation. Use the standard interactive CLI for terminal-confirmed
human approval; the standard SDK refuses programmatic human approval as before.

Applications should use `llm-wiki-compiler`, whose CLI and `createWiki` SDK compose
both packages automatically, including applications supplying their own orchestration.

Build from the repository root with `npm run build`. Requires Node 24 or later.
