import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAdapter, SUPPORTED_HARNESSES } from "../src/adapters/index.mjs";
import { reducePiStreamEvent } from "../src/adapters/pi-sdk.mjs";

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const baseCtx = {
  piAgentDir: "/tmp/open-foundry-test/pi-agent",
  requestTimeoutMs: 1000,
  mock: true,
  HttpError,
  log: () => {},
  foundryOpenAIBaseUrl: "https://example.openai.azure.com/openai/v1",
  foundryOpenAIModel: "gpt-4.1-mini",
  stateDir: "/tmp/open-foundry-test/state",
};

describe("createAdapter", () => {
  it("exposes the supported harnesses", () => {
    assert.deepEqual(SUPPORTED_HARNESSES, ["pi", "copilot", "codex"]);
  });

  it("throws on an unknown harness", () => {
    assert.throws(() => createAdapter("bogus", baseCtx), /unknown HARNESS=bogus/);
  });

  it("pi adapter normalizes to the shared interface", () => {
    const adapter = createAdapter("pi", baseCtx);
    for (const method of ["init", "configureModelProvider", "invoke", "dispose"]) {
      assert.equal(typeof adapter[method], "function", `pi adapter missing ${method}`);
    }
  });

  it("pi adapter returns mock text", async () => {
    const adapter = createAdapter("pi", baseCtx);
    const result = await adapter.invoke("hello", { sessionId: "s1" });
    assert.equal(result.text, "mock response: hello");
    assert.equal(result.mock, true);
  });

  it("copilot adapter returns mock text without starting the CLI", async () => {
    const adapter = createAdapter("copilot", baseCtx);
    await adapter.init();
    await adapter.configureModelProvider();
    const result = await adapter.invoke("hello", { sessionId: "s1", cwd: "/tmp" });
    assert.equal(result.text, "mock response: hello");
    assert.equal(result.mock, true);
    await adapter.dispose();
  });

  it("codex adapter returns mock text without starting the CLI", async () => {
    const adapter = createAdapter("codex", baseCtx);
    await adapter.init();
    await adapter.configureModelProvider();
    const result = await adapter.invoke("hello", { sessionId: "s1", cwd: "/tmp", piSessionDir: "/tmp/open-foundry-test/state/sessions/s1/pi-sessions" });
    assert.equal(result.text, "mock response: hello");
    assert.equal(result.mock, true);
    await adapter.dispose();
  });
});

describe("reducePiStreamEvent", () => {
  const textDelta = (delta) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
  const agentEnd = (messages, willRetry = false) => ({ type: "agent_end", messages, willRetry });

  it("accumulates text_delta and forwards each delta to onTextDelta", () => {
    const state = { text: "", agentEndMessages: undefined };
    const streamed = [];
    reducePiStreamEvent(state, textDelta("Hello"), { onTextDelta: (d) => streamed.push(d) });
    reducePiStreamEvent(state, textDelta(" world"), { onTextDelta: (d) => streamed.push(d) });
    assert.equal(state.text, "Hello world");
    assert.deepEqual(streamed, ["Hello", " world"]);
  });

  it("records the final agent_end messages", () => {
    const state = { text: "", agentEndMessages: undefined };
    const messages = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
    reducePiStreamEvent(state, agentEnd(messages));
    assert.equal(state.agentEndMessages, messages);
  });

  it("drops partial text from a failed attempt when agent_end signals a retry", () => {
    const state = { text: "", agentEndMessages: undefined };
    reducePiStreamEvent(state, textDelta("partial broken"));
    reducePiStreamEvent(state, agentEnd([{ role: "assistant", stopReason: "error", errorMessage: "boom" }], true));
    assert.equal(state.text, "", "text from the failed attempt must be discarded before the retry");
    reducePiStreamEvent(state, textDelta("clean answer"));
    reducePiStreamEvent(state, agentEnd([{ role: "assistant", content: [{ type: "text", text: "clean answer" }] }]));
    assert.equal(state.text, "clean answer");
  });

  it("logs the real errorMessage (not the reason enum) on a stream error event", () => {
    const state = { text: "", agentEndMessages: undefined };
    const logs = [];
    reducePiStreamEvent(
      state,
      { type: "message_update", assistantMessageEvent: { type: "error", reason: "error", errorMessage: "rate limited" } },
      { log: (level, code, meta) => logs.push({ level, code, meta }) },
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0].meta.message, "rate limited");
  });
});
