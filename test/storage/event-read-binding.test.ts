/**
 * @file test/storage/event-read-binding.test.ts
 * @description The event-store read over its sources. This file uses
 * `readEventsFrom`, which exists only after the event reader was given sources
 * to read through, so it has NO before-edit run.
 *
 * There is no project directory. Three in-memory looks decide nothing: `graph`
 * (the graph-store read), `resolvePrivateDir` and `readHeadLeaf` (the head
 * anchor's directory and its one leaf).
 *
 * WHAT IS LOGGED. Every look logs its call to ONE shared, ordered log BEFORE it
 * returns or throws, under its group (`graph.` or `events.`), with the file
 * name and the cap it was passed. The reader's calls are strictly sequential,
 * so the whole log is asserted in order.
 *
 * The production reader runs on what the looks serve: the header, checksum and
 * chain rules; that the anchor is ALWAYS asked, for an absent store too; "no
 * private directory or no leaf means no anchor"; the trim; the comparison; the
 * anchor's oversize error; and which errors leave as the same object. For a
 * link the looks throw what the READER'S OWN factory builds: they never choose
 * the error class.
 *
 * NOT SHOWN HERE: how the local disk confines the graph directory or the
 * private directory, refuses a link or a non-regular leaf, or orders its size
 * look, read and close. The event-store disk tests, `event-head-size-cap.test.ts`
 * and `event-head-legacy.test.ts` show that on real files.
 *
 * The doubles are not a hosted store, not an access-control layer and not
 * `ProjectStore`.
 */

import { describe, expect, it } from "bun:test";
import { eventPrevHash } from "../../src/events/event-digest.js";
import { readEventsFrom, type EventReadSources, type HeadLeafRead } from "../../src/events/store-read.js";
import { eventHeaderLine, serializeEventRecord } from "../../src/events/store-record.js";
import {
  EventStoreCorruptError, EventStoreSymlinkError, GENESIS_PREV_HASH, type EventContent,
} from "../../src/events/types.js";
import { MAX_EVENT_HEAD_BYTES, MAX_RELATION_STORE_BYTES } from "../../src/utils/constants.js";
import { PrivateDirConfinementError } from "../../src/utils/private-dir.js";

const content = (n: number): EventContent => ({ id: `evt_${n}`, type: "relation-create", origin: "test", payload: { n }, at: "2026-01-01T00:00:00Z" });
const ONE = content(1);
const TWO = content(2);
/** Store text for `items` in the given order, each chained to the one before it in `chain` (default: the same order). */
const storeOf = (items: EventContent[], chain: EventContent[] = items): string => eventHeaderLine() + items.map((item) => {
  const at = chain.indexOf(item);
  return serializeEventRecord({ ...item, prevHash: at === 0 ? GENESIS_PREV_HASH : eventPrevHash(chain[at - 1]!) });
}).join("");
const text = (value: string): HeadLeafRead => ({ kind: "text", text: value });

interface Held {
  /** The graph read's answer: store text, `null` for no store, `"link"`, `"oversize"`, or an `Error` it rejects with. */
  store?: string | null | "link" | "oversize" | Error;
  /** The private directory: a token, `null` for none, or an `Error` the resolution rejects with. */
  privateDir?: string | null | Error;
  /** The head leaf's answer, `"link"`, or an `Error` the look rejects with. */
  head?: HeadLeafRead | "link" | Error;
}

/** Sources held in memory, the complete call log, and every error a factory built for a look. */
function sourcesOf(held: Held = {}): { sources: EventReadSources; calls: string[]; built: Error[] } {
  const calls: string[] = [];
  const built: Error[] = [];
  const make = (error: Error): Error => { built.push(error); return error; };
  const sources: EventReadSources = {
    graph: { readStore: async (config) => {
      calls.push(`graph.readStore ${config.fileName} max=${config.maxBytes}`);
      const store = held.store === undefined ? null : held.store;
      if (store === "link") throw make(config.makeSymlinkError("store file is a symlink"));
      if (store === "oversize") throw make(config.makeOversizeError(config.maxBytes + 1));
      if (store instanceof Error) throw store;
      return store;
    } },
    resolvePrivateDir: async () => {
      calls.push("events.resolvePrivateDir");
      const dir = held.privateDir === undefined ? "mem:private" : held.privateDir;
      if (dir instanceof Error) throw dir;
      return dir;
    },
    readHeadLeaf: async (dir, name, maxBytes, makeSymlinkError) => {
      calls.push(`events.readHeadLeaf ${dir}/${name} max=${maxBytes}`);
      const head = held.head ?? { kind: "absent" };
      if (head === "link") throw make(makeSymlinkError("store file is a symlink"));
      if (head instanceof Error) throw head;
      return head;
    },
  };
  return { sources, calls, built };
}

const GRAPH = `graph.readStore events.jsonl max=${MAX_RELATION_STORE_BYTES}`;
const RESOLVE = "events.resolvePrivateDir";
const HEAD = `events.readHeadLeaf mem:private/events.head max=${MAX_EVENT_HEAD_BYTES}`;
const read = async (held: Held) => { const { sources, calls } = sourcesOf(held); return { result: await readEventsFrom(sources), calls }; };
const failure = async (held: Held) => {
  const { sources, calls, built } = sourcesOf(held);
  const error = await readEventsFrom(sources).then(() => "resolved", (thrown: unknown) => thrown);
  return { error, calls, built };
};

describe("the event read over its sources: the anchor is always asked", () => {
  it("V1 asks for the anchor even when there is no store, and takes no private directory as no anchor", async () => {
    expect(await read({ privateDir: null })).toEqual({ result: { events: [], problems: [] }, calls: [GRAPH, RESOLVE] });
  });

  it("V2 takes an absent head leaf as no anchor, for no store and for a header-only store", async () => {
    expect(await read({})).toEqual({ result: { events: [], problems: [] }, calls: [GRAPH, RESOLVE, HEAD] });
    expect(await read({ store: eventHeaderLine() })).toEqual({ result: { events: [], problems: [] }, calls: [GRAPH, RESOLVE, HEAD] });
  });

  it("V3 reports a head that still names a digest over an empty store as a problem, not a healthy empty log", async () => {
    const { result } = await read({ head: text("abc123\n") });
    expect(result).toEqual({ events: [], problems: ["head anchor abc123 does not match last event"] });
  });
});

describe("the event read over its sources: chain and anchor", () => {
  it("V4 reads the events in file order and accepts the trimmed anchor of the last one, in three calls", async () => {
    const { result, calls } = await read({ store: storeOf([ONE, TWO]), head: text(`  ${eventPrevHash(TWO)}\n`) });
    expect([result.events.map((event) => event.id), result.problems, calls]).toEqual([["evt_1", "evt_2"], [], [GRAPH, RESOLVE, HEAD]]);
  });

  it("V5 reports an anchor that names another event, and an absent anchor over a non-empty store", async () => {
    const stale = await read({ store: storeOf([ONE, TWO]), head: text(eventPrevHash(ONE)) });
    expect(stale.result.problems).toEqual([`head anchor ${eventPrevHash(ONE)} does not match last event`]);
    const none = await read({ store: storeOf([ONE]) });
    expect([none.result.events.length, none.result.problems]).toEqual([1, ["head anchor <absent> does not match last event"]]);
  });

  it("V6 reports a broken chain link as a problem and still asks for the anchor", async () => {
    const { result, calls } = await read({ store: storeOf([TWO, ONE], [ONE, TWO]), head: text(eventPrevHash(ONE)) });
    expect([result.problems, calls]).toEqual([["chain link broken at event 0 (evt_2)"], [GRAPH, RESOLVE, HEAD]]);
  });
});

describe("the event read over its sources: failures", () => {
  it("V7 turns an oversize head leaf into the event store's corrupt error, naming its size and the cap", async () => {
    const { error, calls } = await failure({ store: storeOf([ONE]), head: { kind: "oversize", size: MAX_EVENT_HEAD_BYTES + 1 } });
    expect(error).toEqual(new EventStoreCorruptError(`head anchor file ${MAX_EVENT_HEAD_BYTES + 1} bytes exceeds the ${MAX_EVENT_HEAD_BYTES}-byte cap`));
    expect(calls).toEqual([GRAPH, RESOLVE, HEAD]);
  });

  it("V8 rejects a linked head leaf with the very error its own factory built, an event-store link error", async () => {
    const { error, built } = await failure({ store: storeOf([ONE]), head: "link" });
    expect(built).toHaveLength(1);
    expect(error).toBe(built[0]);
    expect(error).toBeInstanceOf(EventStoreSymlinkError);
  });

  it("V9 builds the store's own link and oversize errors through its configuration, and asks for no anchor after them", async () => {
    const link = await failure({ store: "link" });
    const oversize = await failure({ store: "oversize" });
    expect([link.error, link.calls]).toEqual([link.built[0], [GRAPH]]);
    expect(link.error).toBeInstanceOf(EventStoreSymlinkError);
    expect(oversize.error).toEqual(new EventStoreCorruptError(`store file ${MAX_RELATION_STORE_BYTES + 1} bytes exceeds the ${MAX_RELATION_STORE_BYTES}-byte cap`));
    expect(oversize.calls).toEqual([GRAPH]);
  });

  it("V10 lets every other failure leave as the same object: the store read, the private directory, the head leaf", async () => {
    const refused = new Error("EIO: refused");
    const confinement = new PrivateDirConfinementError("escapes");
    expect((await failure({ store: refused })).error).toBe(refused);
    expect(await failure({ privateDir: confinement })).toMatchObject({ error: confinement, calls: [GRAPH, RESOLVE] });
    expect((await failure({ privateDir: confinement })).error).toBe(confinement);
    expect((await failure({ head: refused })).error).toBe(refused);
  });
});
