/** A small isolated browser document for direct renderer tests, cleaned after every case. */
import { afterEach, beforeEach } from "bun:test";
import { restoreGlobals, stubGlobal } from "../stubs.js";
import { JSDOM } from "jsdom";

/** Own the global document stub and DOM lifetime for a test suite. */
export function useViewerDocument() {
  const context = {} as { dom: JSDOM; main: HTMLElement };
  beforeEach(() => {
    context.dom = new JSDOM("<main></main>", { url: "http://localhost" });
    stubGlobal("document", context.dom.window.document);
    context.main = context.dom.window.document.querySelector("main")!;
  });
  afterEach(() => { context.dom.window.close(); restoreGlobals(); });
  return context;
}
