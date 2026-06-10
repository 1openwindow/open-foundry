import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contract, validateRuntimeEnv } from "../src/contract.mjs";

describe("contract", () => {
  it("declares schemaVersion and required runtime sections", () => {
    assert.equal(typeof contract.schemaVersion, "string");
    assert.ok(contract.runtime.startupCommand.includes("/app/src/backend.mjs"));
    assert.ok(Array.isArray(contract.resourceTiers) && contract.resourceTiers.length > 0);
    for (const tier of contract.resourceTiers) {
      assert.ok(/^[0-9.]+$/.test(tier.cpu), `cpu must be numeric string: ${tier.cpu}`);
      assert.ok(/Gi$/.test(tier.memory), `memory must end in Gi: ${tier.memory}`);
    }
  });

  it("reserves AGENT_ and FOUNDRY_ prefixes but allows FOUNDRY_PROJECT_ENDPOINT", () => {
    assert.deepEqual(contract.env.reservedPrefixes, ["AGENT_", "FOUNDRY_"]);
    assert.ok(contract.env.reservedAllowedExceptions.includes("FOUNDRY_PROJECT_ENDPOINT"));
  });

  it("requires the OF_OPENAI_* triple at runtime", () => {
    assert.deepEqual(contract.env.requiredWhenLive.sort(), ["OF_OPENAI_API_KEY", "OF_OPENAI_BASE_URL", "OF_OPENAI_MODEL"]);
  });
});

describe("validateRuntimeEnv", () => {
  it("returns three errors when live and OF_OPENAI_* triple is missing", () => {
    const issues = validateRuntimeEnv({}, { mock: false });
    const errorNames = issues.filter((i) => i.severity === "error").map((i) => i.name).sort();
    assert.deepEqual(errorNames, ["OF_OPENAI_API_KEY", "OF_OPENAI_BASE_URL", "OF_OPENAI_MODEL"]);
  });

  it("skips OF_OPENAI_* requirement when mock=true", () => {
    const issues = validateRuntimeEnv({}, { mock: true });
    const errors = issues.filter((i) => i.severity === "error");
    assert.deepEqual(errors, []);
  });

  it("treats empty string as missing", () => {
    const issues = validateRuntimeEnv({ OF_OPENAI_API_KEY: "", OF_OPENAI_BASE_URL: "   ", OF_OPENAI_MODEL: "x" }, { mock: false });
    const errorNames = issues.filter((i) => i.severity === "error").map((i) => i.name).sort();
    assert.deepEqual(errorNames, ["OF_OPENAI_API_KEY", "OF_OPENAI_BASE_URL"]);
  });

  it("passes when all required OF_OPENAI_* values are set", () => {
    const issues = validateRuntimeEnv(
      { OF_OPENAI_API_KEY: "sk-x", OF_OPENAI_BASE_URL: "https://x", OF_OPENAI_MODEL: "gpt-4.1-mini" },
      { mock: false },
    );
    assert.deepEqual(issues.filter((i) => i.severity === "error"), []);
  });

  it("does not require OF_OPENAI_API_KEY when OF_MODEL_AUTH=managed-identity", () => {
    const issues = validateRuntimeEnv(
      { OF_MODEL_AUTH: "managed-identity", OF_OPENAI_BASE_URL: "https://x", OF_OPENAI_MODEL: "gpt-4.1-mini" },
      { mock: false },
    );
    assert.deepEqual(issues.filter((i) => i.severity === "error"), []);
  });

  it("still requires base url + model when OF_MODEL_AUTH=managed-identity", () => {
    const issues = validateRuntimeEnv({ OF_MODEL_AUTH: "managed-identity" }, { mock: false });
    const errorNames = issues.filter((i) => i.severity === "error").map((i) => i.name).sort();
    assert.deepEqual(errorNames, ["OF_OPENAI_BASE_URL", "OF_OPENAI_MODEL"]);
  });

  it("does not warn on AGENT_* (populated by Foundry, informational only)", () => {
    const issues = validateRuntimeEnv(
      { AGENT_FOO_NAME: "x", AGENT_FOO_VERSION: "1", OF_MOCK: "1" },
      { mock: true },
    );
    const agentIssues = issues.filter((i) => i.name.startsWith("AGENT_"));
    assert.deepEqual(agentIssues, []);
  });

  it("allows the FOUNDRY_PROJECT_ENDPOINT exception without a warning", () => {
    const issues = validateRuntimeEnv({ FOUNDRY_PROJECT_ENDPOINT: "https://x", OF_MOCK: "1" }, { mock: true });
    assert.deepEqual(issues.filter((i) => i.name === "FOUNDRY_PROJECT_ENDPOINT"), []);
  });

  it("does not warn on documented FOUNDRY_ aliases used by the paseo shim", () => {
    const issues = validateRuntimeEnv(
      { FOUNDRY_MODEL: "gpt-4.1-mini", FOUNDRY_INVOCATIONS_ENDPOINT: "https://x", OF_MOCK: "1" },
      { mock: true },
    );
    assert.deepEqual(issues.filter((i) => i.severity === "warning"), []);
  });

  it("warns on undocumented FOUNDRY_-prefixed user variables", () => {
    const issues = validateRuntimeEnv({ FOUNDRY_MY_CUSTOM_THING: "x", OF_MOCK: "1" }, { mock: true });
    const warnings = issues.filter((i) => i.severity === "warning" && i.name === "FOUNDRY_MY_CUSTOM_THING");
    assert.equal(warnings.length, 1);
  });

  it("errors on an unknown HARNESS value", () => {
    const issues = validateRuntimeEnv({ HARNESS: "bogus", OF_MOCK: "1" }, { mock: true });
    const harnessErrors = issues.filter((i) => i.severity === "error" && i.name === "HARNESS");
    assert.equal(harnessErrors.length, 1);
  });

  it("treats a blank HARNESS as the default pi (azd expands unset vars to '')", () => {
    const issues = validateRuntimeEnv({ HARNESS: "", OF_MOCK: "1" }, { mock: true });
    const harnessErrors = issues.filter((i) => i.severity === "error" && i.name === "HARNESS");
    assert.deepEqual(harnessErrors, []);
  });

  it("rejects HARNESS=copilot with OF_MODEL_AUTH=managed-identity (BYOK is apikey only)", () => {
    const issues = validateRuntimeEnv(
      { HARNESS: "copilot", OF_MODEL_AUTH: "managed-identity", OF_OPENAI_BASE_URL: "https://x", OF_OPENAI_MODEL: "gpt-4.1-mini" },
      { mock: false },
    );
    const authErrors = issues.filter((i) => i.severity === "error" && i.name === "OF_MODEL_AUTH");
    assert.equal(authErrors.length, 1);
    // copilot has no keyless path, so the API key is still required.
    assert.ok(issues.some((i) => i.severity === "error" && i.name === "OF_OPENAI_API_KEY"));
  });

  it("accepts HARNESS=copilot with the apikey triple", () => {
    const issues = validateRuntimeEnv(
      { HARNESS: "copilot", OF_OPENAI_API_KEY: "sk-x", OF_OPENAI_BASE_URL: "https://x", OF_OPENAI_MODEL: "gpt-4.1-mini" },
      { mock: false },
    );
    assert.deepEqual(issues.filter((i) => i.severity === "error"), []);
  });

  it("rejects an invalid COPILOT_WIRE_API only under the copilot harness", () => {
    const base = { OF_OPENAI_API_KEY: "sk-x", OF_OPENAI_BASE_URL: "https://x", OF_OPENAI_MODEL: "gpt-4.1-mini" };
    const copilot = validateRuntimeEnv({ HARNESS: "copilot", COPILOT_WIRE_API: "bogus", ...base }, { mock: false });
    assert.ok(copilot.some((i) => i.severity === "error" && i.name === "COPILOT_WIRE_API"));
    // pi never reads COPILOT_*, so the same typo must not error there.
    const pi = validateRuntimeEnv({ COPILOT_WIRE_API: "bogus", ...base }, { mock: false });
    assert.equal(pi.filter((i) => i.name === "COPILOT_WIRE_API").length, 0);
  });

  it("rejects an invalid COPILOT_PROVIDER_TYPE under the copilot harness", () => {
    const issues = validateRuntimeEnv(
      { HARNESS: "copilot", COPILOT_PROVIDER_TYPE: "anthropic", OF_OPENAI_API_KEY: "sk-x", OF_OPENAI_BASE_URL: "https://x", OF_OPENAI_MODEL: "gpt-4.1-mini" },
      { mock: false },
    );
    assert.ok(issues.some((i) => i.severity === "error" && i.name === "COPILOT_PROVIDER_TYPE"));
  });

  it("accepts HARNESS=codex with the apikey triple", () => {
    const issues = validateRuntimeEnv(
      { HARNESS: "codex", OF_OPENAI_API_KEY: "sk-x", OF_OPENAI_BASE_URL: "https://x", OF_OPENAI_MODEL: "gpt-5.1" },
      { mock: false },
    );
    assert.deepEqual(issues.filter((i) => i.severity === "error"), []);
  });

  it("rejects HARNESS=codex with OF_MODEL_AUTH=managed-identity (BYOK is apikey only)", () => {
    const issues = validateRuntimeEnv(
      { HARNESS: "codex", OF_MODEL_AUTH: "managed-identity", OF_OPENAI_BASE_URL: "https://x", OF_OPENAI_MODEL: "gpt-5.1" },
      { mock: false },
    );
    const authErrors = issues.filter((i) => i.severity === "error" && i.name === "OF_MODEL_AUTH");
    assert.equal(authErrors.length, 1);
    assert.ok(issues.some((i) => i.severity === "error" && i.name === "OF_OPENAI_API_KEY"));
  });

  it("rejects an invalid CODEX_WIRE_API only under the codex harness", () => {
    const base = { OF_OPENAI_API_KEY: "sk-x", OF_OPENAI_BASE_URL: "https://x", OF_OPENAI_MODEL: "gpt-5.1" };
    const codex = validateRuntimeEnv({ HARNESS: "codex", CODEX_WIRE_API: "bogus", ...base }, { mock: false });
    assert.ok(codex.some((i) => i.severity === "error" && i.name === "CODEX_WIRE_API"));
    const pi = validateRuntimeEnv({ CODEX_WIRE_API: "bogus", ...base }, { mock: false });
    assert.equal(pi.filter((i) => i.name === "CODEX_WIRE_API").length, 0);
  });

  it("accepts HARNESS=opencode with the apikey triple", () => {
    const issues = validateRuntimeEnv(
      { HARNESS: "opencode", OF_OPENAI_API_KEY: "sk-x", OF_OPENAI_BASE_URL: "https://x", OF_OPENAI_MODEL: "gpt-4.1-mini" },
      { mock: false },
    );
    assert.deepEqual(issues.filter((i) => i.severity === "error"), []);
  });

  it("rejects HARNESS=opencode with OF_MODEL_AUTH=managed-identity (BYOK is apikey only)", () => {
    const issues = validateRuntimeEnv(
      { HARNESS: "opencode", OF_MODEL_AUTH: "managed-identity", OF_OPENAI_BASE_URL: "https://x", OF_OPENAI_MODEL: "gpt-4.1-mini" },
      { mock: false },
    );
    const authErrors = issues.filter((i) => i.severity === "error" && i.name === "OF_MODEL_AUTH");
    assert.equal(authErrors.length, 1);
    assert.ok(issues.some((i) => i.severity === "error" && i.name === "OF_OPENAI_API_KEY"));
  });
});
