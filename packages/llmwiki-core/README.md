# @atomicstrata/llmwiki-core

The engine-free implementation package for llmwiki knowledge and domain services.
Applications should import `llm-wiki-compiler` instead.
This package is publicly downloadable but its direct exports are internal
composition contracts, not a separately supported consumer API.

Internal composition example for compiler maintainers:

```js
import { createWikiCore } from "@atomicstrata/llmwiki-core";
const wiki = createWikiCore({ root: "/absolute/project/path" });
```

Core exposes knowledge, profiles, retained artifacts, preparations, records and
passive local-workflow history. It has no workflow-start/advance SDK methods and
does not depend on the local workflow engine. Existing grants, profile checks,
reviewed mutations and path confinement still apply; choosing core is not a grant.

The standard `llm-wiki-compiler` package remains the compatible CLI and full SDK.
Its support entries compose this same core instance. The optional
`@atomicstrata/llmwiki-local-workflows` engine requires a matching core peer and an explicit
host constructed through `@atomicstrata/llmwiki-core/local-workflow-host`.

Build from the repository root with `npm run build`. Local installation before
publication must supply matching tarballs explicitly; no runtime downloading or
fallback is provided. See the repository's ARCHITECTURE.md for ownership and
package-analysis conventions. Requires Node 24 or later.
