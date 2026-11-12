/**
 * @file test/entities-owner.test.ts
 * @description The owner page: a body written from the week pages (newest
 * first, citations kept and fitted to the lines the weeks cite), a People
 * section built with no model call and grouped by relationship, no model call
 * when nothing it is written from changed, and a hand-written page at its id
 * left alone.
 */

import { describe, expect, it } from "bun:test";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { generateEntitiesWith } from "../src/entities/generate.js";
import { generateOwnerPageWith, type OwnerSteps } from "../src/entities/owner.js";
import { extractableTypes } from "../src/entities/schema.js";
import type { PageRequest } from "../src/compiler/source-excerpt.js";
import { entityConfig, memoryEntitySteps, personProfile, type FakePerson } from "./entity-steps.js";

const CHAT = ["# Chat", "- 2026-05-04 09:00 Sam: Ana is coming", "- 2026-05-05 10:00 Ana: hi", "- 2026-05-05 10:01 Alex: hey"].join("\n");
const PEOPLE: Record<string, FakePerson[]> = { "chat.md": [{ name: "Ana", relationship: "friend", line: 2 }, { name: "Alex", line: 4 }] };
const OWNER = { owner: { type: "person", names: ["Sam", "Sam Rivera"] }, entities: {} };

/** A week page as the timeline writes it, with `body`. */
function weekPage(week: string, body: string): string {
  return `---\ntitle: Week\ntimeline: weekly\nweek: ${week}\ntimelineSignature: s\n---\n\n${body}\n`;
}

/** Person pages from the entity step, two week pages, and owner steps whose model cites the first week's citation. */
async function project() {
  const memory = memoryEntitySteps({ "chat.md": CHAT }, PEOPLE, OWNER);
  await generateEntitiesWith(memory.steps, entityConfig());
  memory.pages.set("timeline/2026-W19", weekPage("2026-W19", "- Ana visited. ^[chat.md:2-2]"));
  memory.pages.set("timeline/2026-W18", weekPage("2026-W18", "- Planned. ^[chat.md:3-3]"));
  const requests: PageRequest[] = [];
  const steps: OwnerSteps = {
    ...memory.steps, readRegistry: async () => memory.state.registry,
    complete: async (request) => {
      requests.push(request);
      return `SUMMARY: Sam is busy.\n## Now\n\n- Hosting Ana. ^[chat.md:2-3]`;
    },
  };
  return { memory, steps, requests, type: extractableTypes(personProfile())[0] };
}

describe("the owner page", () => {
  it("is written from the week pages, newest first, with a People section grouped by relationship", async () => {
    const { memory, steps, requests, type } = await project();
    expect((await generateOwnerPageWith(steps, type)).written).toEqual(["person/sam"]);
    const page = parseFrontmatter(memory.pages.get("person/sam")!);
    expect(page.meta).toMatchObject({ title: "Sam", aliases: ["Sam Rivera"], summary: "Sam is busy." });
    expect(requests[0].messages[0].content.indexOf("2026-W19")).toBeLessThan(requests[0].messages[0].content.indexOf("2026-W18"));
    expect(page.body).toContain("- Hosting Ana. ^[chat.md:2-3]");
    expect(page.body).toContain("## People\n\n### Friend\n\n- [[person/ana|Ana]] — Ana is someone the owner knows.\n\n### Not stated\n\n- [[person/alex|Alex]]");
  });

  it("groups by the first declared enum field, and keeps a value a page still carries outside it", async () => {
    const { memory, steps, type } = await project();
    memory.pages.set("person/alex", memory.pages.get("person/alex")!.replace("title: Alex", "title: Alex\nrelationship: mentor"));
    await generateOwnerPageWith(steps, type);
    expect(memory.pages.get("person/sam")).toContain("### Friend\n\n- [[person/ana|Ana]] — Ana is someone the owner knows.\n\n### Mentor\n\n- [[person/alex|Alex]]");
  });

  it("makes no model call and writes nothing when nothing it is written from changed", async () => {
    const { steps, requests, type } = await project();
    await generateOwnerPageWith(steps, type);
    expect(await generateOwnerPageWith(steps, type)).toEqual({ written: [], deleted: [], errors: [] });
    expect(requests).toHaveLength(1);
  });

  it("refreshes only the People section when the people change, and regenerates when a week changes", async () => {
    const { memory, steps, requests, type } = await project();
    await generateOwnerPageWith(steps, type);
    memory.pages.delete("person/alex");
    await generateOwnerPageWith(steps, type);
    expect([requests.length, memory.pages.get("person/sam")!.includes("person/alex")]).toEqual([1, false]);
    memory.pages.set("timeline/2026-W19", weekPage("2026-W19", "- Ana left. ^[chat.md:2-2]"));
    await generateOwnerPageWith(steps, type);
    expect(requests).toHaveLength(2);
  });

  it("fits a citation to the lines the weeks cite, and reports one they never cite", async () => {
    const { memory, steps, type } = await project();
    steps.complete = async () => "SUMMARY: Sam.\n## Now\n\n- A. ^[chat.md:2-3]\n- B. ^[chat.md:9-9]";
    const result = await generateOwnerPageWith(steps, type);
    expect(result.errors).toEqual(['Page "person/sam" cites 1 span outside the lines it was written from']);
    expect(memory.pages.get("person/sam")).toContain("- A. ^[chat.md:2-3]");
  });

  it("is the People section alone, with no model call, when there are no week pages", async () => {
    const { memory, steps, requests, type } = await project();
    memory.pages.delete("timeline/2026-W19");
    memory.pages.delete("timeline/2026-W18");
    await generateOwnerPageWith(steps, type);
    const page = parseFrontmatter(memory.pages.get("person/sam")!);
    expect([requests.length, page.meta.summary]).toEqual([0, "The owner of this memory."]);
    expect(page.body).toContain("## People");
  });

  it("leaves a hand-written page at the owner's id alone, and does nothing without an owner", async () => {
    const { memory, steps, requests, type } = await project();
    memory.pages.set("person/sam", "---\ntitle: Sam\n---\n\nMine.\n");
    const result = await generateOwnerPageWith(steps, type);
    expect(result.errors).toEqual(["wiki/person/sam.md was not written by entity extraction; left as it is"]);
    memory.state.registry = { entities: {} };
    expect(await generateOwnerPageWith(steps, type)).toEqual({ written: [], deleted: [], errors: [] });
    expect([requests.length, memory.pages.get("person/sam")]).toEqual([0, "---\ntitle: Sam\n---\n\nMine.\n"]);
  });
});
