/**
 * @file test/openai-embeddings-credential.test.ts
 * @description Which credential reaches a separate embeddings endpoint, and
 * whether the user is told (issue #154).
 *
 * `OPENAI_EMBEDDINGS_BASE_URL` points the embeddings client at another host
 * while the chat client stays on OpenAI. The embeddings client reuses
 * `OPENAI_API_KEY` unless told otherwise, which means naming a third-party
 * endpoint silently ships a cloud OpenAI key to its operator — nothing in the
 * configuration says so.
 *
 * Forwarding is KEPT, because setups pointing at hosted OpenAI-compatible
 * services depend on it; what changes is that it is now announceable and
 * overridable. `OPENAI_EMBEDDINGS_API_KEY` takes precedence, and forwarding to a
 * non-loopback host warns once. Loopback is exempt: a key that never leaves the
 * machine is not a disclosure, and warning on every local dev run would train
 * people to ignore the message that matters.
 */

import { describe, it, expect, vi, afterEach } from "bun:test";
import { OpenAIProvider, resetForwardedKeyWarnings } from "../src/providers/openai.js";
import * as output from "../src/utils/output.js";
import { createEnvSnapshot } from "./fixtures/env-snapshot.js";

const { setEnv, restore } = createEnvSnapshot(["OPENAI_API_KEY"]);

const REMOTE = "https://embeddings.example.com/v1";
const LOCAL = "http://localhost:8000/v1";

afterEach(() => {
  restore();
  resetForwardedKeyWarnings();
  vi.restoreAllMocks();
});

/** The apiKey the constructed provider hands its EMBEDDINGS client. */
function embeddingsKeyOf(provider: OpenAIProvider): string {
  return Reflect.get(Reflect.get(provider, "embeddingsClient"), "apiKey") as string;
}

/**
 * Silence and capture `output.status`. Bun's spyOn returns the EXISTING spy when
 * the method is already spied, so clear it: the calls must be this build's alone.
 */
function silenceStatus() {
  const warn = vi.spyOn(output, "status").mockImplementation(() => {});
  warn.mockClear();
  return warn;
}

/** Build a provider with a separate embeddings endpoint, capturing warnings. */
function buildWithEndpoint(embeddingsBaseURL: string, embeddingsApiKey?: string) {
  const warn = silenceStatus();
  const provider = new OpenAIProvider("gpt-4o", { embeddingsBaseURL, embeddingsApiKey });
  const messages = warn.mock.calls.map((call) => String(call[1]));
  return { provider, messages };
}

describe("a separate embeddings endpoint", () => {
  it("uses OPENAI_EMBEDDINGS_API_KEY when set, and stays quiet", () => {
    setEnv({ OPENAI_API_KEY: "sk-cloud" });
    const { provider, messages } = buildWithEndpoint(REMOTE, "sk-embed");
    expect(embeddingsKeyOf(provider)).toBe("sk-embed");
    expect(messages).toEqual([]);
  });

  it("forwards OPENAI_API_KEY when no dedicated key is set, and says so", () => {
    setEnv({ OPENAI_API_KEY: "sk-cloud" });
    const { provider, messages } = buildWithEndpoint(REMOTE);
    expect(embeddingsKeyOf(provider)).toBe("sk-cloud");
    expect(messages.join("\n")).toMatch(/OPENAI_API_KEY.*embeddings.example.com/s);
    expect(messages.join("\n")).toMatch(/OPENAI_EMBEDDINGS_API_KEY/);
  });

  it("does not warn for a loopback endpoint", () => {
    setEnv({ OPENAI_API_KEY: "sk-cloud" });
    const { messages } = buildWithEndpoint(LOCAL);
    expect(messages).toEqual([]);
  });

  it("does not warn when there is no real key to forward", () => {
    setEnv({ OPENAI_API_KEY: undefined });
    const { messages } = buildWithEndpoint(REMOTE);
    expect(messages).toEqual([]);
  });

  it("flags a remote plaintext endpoint", () => {
    setEnv({ OPENAI_API_KEY: "sk-cloud" });
    const { messages } = buildWithEndpoint("http://embeddings.example.com/v1");
    expect(messages.join("\n")).toMatch(/plaintext http/);
  });

  it("warns once per endpoint, not once per provider build", () => {
    setEnv({ OPENAI_API_KEY: "sk-cloud" });
    // Providers are constructed per embedding call on some paths; a warning on
    // each would bury the compile output it is meant to interrupt.
    expect(buildWithEndpoint(REMOTE).messages).toHaveLength(1);
    expect(buildWithEndpoint(REMOTE).messages).toEqual([]);
  });
});

describe("no separate embeddings endpoint", () => {
  it("shares the chat client, so no forwarding decision arises", () => {
    setEnv({ OPENAI_API_KEY: "sk-cloud" });
    const warn = silenceStatus();
    const provider = new OpenAIProvider("gpt-4o", {});
    expect(Reflect.get(provider, "embeddingsClient")).toBe(Reflect.get(provider, "client"));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the warning does not itself disclose a credential", () => {
  // The warning exists to report a credential disclosure, so printing the
  // endpoint verbatim would leak a second one into scrollback and CI logs.
  it("strips userinfo from the printed endpoint", () => {
    setEnv({ OPENAI_API_KEY: "sk-cloud" });
    const { messages } = buildWithEndpoint("https://user:hunter2@embeddings.example.com/v1");
    expect(messages.join("\n")).not.toContain("hunter2");
    expect(messages.join("\n")).toContain("embeddings.example.com");
  });

  it("strips query-parameter values from the printed endpoint", () => {
    setEnv({ OPENAI_API_KEY: "sk-cloud" });
    const { messages } = buildWithEndpoint("https://embeddings.example.com/v1?api-key=sk-secret");
    expect(messages.join("\n")).not.toContain("sk-secret");
    // The parameter NAME stays: it identifies the endpoint without disclosing it.
    expect(messages.join("\n")).toContain("api-key");
  });
});

describe("a dedicated embeddings key with no separate endpoint", () => {
  // The provider guard accepts OPENAI_EMBEDDINGS_API_KEY on its own. If the
  // embeddings client is built only for a separate ENDPOINT, that key is
  // dropped and embedding authenticates as the chat client's placeholder —
  // startup validation passes and the failure resurfaces as a late 401.
  it("honours the dedicated key rather than the chat placeholder", () => {
    setEnv({ OPENAI_API_KEY: undefined });
    const provider = new OpenAIProvider("gpt-4o", { embeddingsApiKey: "sk-embed" });
    expect(embeddingsKeyOf(provider)).toBe("sk-embed");
  });

  it("prefers the dedicated key over a chat key that is set", () => {
    setEnv({ OPENAI_API_KEY: "sk-cloud" });
    const provider = new OpenAIProvider("gpt-4o", { embeddingsApiKey: "sk-embed" });
    expect(embeddingsKeyOf(provider)).toBe("sk-embed");
  });

  it("stays on the chat base URL, since only the credential differs", () => {
    setEnv({ OPENAI_API_KEY: undefined });
    const provider = new OpenAIProvider("gpt-4o", { baseURL: LOCAL, embeddingsApiKey: "sk-embed" });
    expect(Reflect.get(Reflect.get(provider, "embeddingsClient"), "baseURL")).toBe(LOCAL);
  });

  it("does not warn: a key with no separate endpoint is forwarded nowhere", () => {
    setEnv({ OPENAI_API_KEY: "sk-cloud" });
    const warn = silenceStatus();
    new OpenAIProvider("gpt-4o", { embeddingsApiKey: "sk-embed" });
    expect(warn).not.toHaveBeenCalled();
  });
});
