/**
 * Offline fetch preload for real-CLI tests that need a successful embeddings
 * pass without opening a loopback listener in restricted CI sandboxes.
 */

const VECTOR = Array.from({ length: 8 }, (_, index) => index / 10);

globalThis.fetch = async (_input, init = {}) => {
  const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  return new Response(JSON.stringify({
    object: "list",
    data: inputs.map((_value, index) => ({ object: "embedding", index, embedding: VECTOR })),
    model: body.model ?? "nomic-embed-text",
    usage: { prompt_tokens: 1, total_tokens: 1 },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
