/**
 * @file test/call-counter-child.ts
 * @description The child-process preload of the call counter (see
 * `call-counting.ts`). A CLI a test spawns counts its own calls, named
 * `child.<op>`, and records them on exit under the spawning test file.
 */

import { installCallCounting, recordCallCounts } from "./call-counting.ts";

await installCallCounting("child.");
process.on("exit", () => recordCallCounts(process.env.LLMWIKI_CALL_COUNTS_FILE ?? "unknown"));
