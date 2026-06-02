import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAdapter, SUPPORTED_HARNESSES } from "../src/adapters/index.mjs";

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const baseCtx = {
  piBin: "pi",
  piArgs: [],
  piAgentDir: "/tmp/pi-foundry-test/pi-agent",
  requestTimeoutMs: 1000,
  mock: true,
  HttpError,
  log: () => {},
  foundryOpenAIBaseUrl: "https://example.openai.azure.com/openai/v1",
  foundryOpenAIModel: "gpt-4.1-mini",
  stateDir: "/tmp/pi-foundry-test/state",
};

describe("createAdapter", () => {
  it("exposes the supported harnesses", () => {
    assert.deepEqual(SUPPORTED_HARNESSES, ["pi", "copilot"]);
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
});
