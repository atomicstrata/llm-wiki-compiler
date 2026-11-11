import { it } from "bun:test";
import { emptyWorkspace } from "../preparation-cli-fixture.js";
it("probe", async () => {
  const root = await emptyWorkspace("probe");
  const { fixturePlan, stageRequest } = await import("../preparations/store-fixture.js");
  const { stagePreparationLocked } = await import("../../src/preparations/stage.js");
  for (let i = 0; i < 3; i++) {
    (globalThis as any).__probe = true;
    console.log("=== stage", i);
    const plan = fixturePlan((o) => { o.workspaceId = `ws-0`; });
    await stagePreparationLocked(root, stageRequest(plan));
  }
}, 60000);
