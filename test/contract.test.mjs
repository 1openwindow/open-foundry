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

  it("requires the PI_OPENAI_* triple at runtime", () => {
    assert.deepEqual(contract.env.requiredWhenLive.sort(), ["PI_OPENAI_API_KEY", "PI_OPENAI_BASE_URL", "PI_OPENAI_MODEL"]);
  });
});

describe("validateRuntimeEnv", () => {
  it("returns three errors when live and PI_OPENAI_* triple is missing", () => {
    const issues = validateRuntimeEnv({}, { mock: false });
    const errorNames = issues.filter((i) => i.severity === "error").map((i) => i.name).sort();
    assert.deepEqual(errorNames, ["PI_OPENAI_API_KEY", "PI_OPENAI_BASE_URL", "PI_OPENAI_MODEL"]);
  });

  it("skips PI_OPENAI_* requirement when mock=true", () => {
    const issues = validateRuntimeEnv({}, { mock: true });
    const errors = issues.filter((i) => i.severity === "error");
    assert.deepEqual(errors, []);
  });

  it("treats empty string as missing", () => {
    const issues = validateRuntimeEnv({ PI_OPENAI_API_KEY: "", PI_OPENAI_BASE_URL: "   ", PI_OPENAI_MODEL: "x" }, { mock: false });
    const errorNames = issues.filter((i) => i.severity === "error").map((i) => i.name).sort();
    assert.deepEqual(errorNames, ["PI_OPENAI_API_KEY", "PI_OPENAI_BASE_URL"]);
  });

  it("passes when all required PI_OPENAI_* values are set", () => {
    const issues = validateRuntimeEnv(
      { PI_OPENAI_API_KEY: "sk-x", PI_OPENAI_BASE_URL: "https://x", PI_OPENAI_MODEL: "gpt-4.1-mini" },
      { mock: false },
    );
    assert.deepEqual(issues.filter((i) => i.severity === "error"), []);
  });

  it("does not require PI_OPENAI_API_KEY when PI_MODEL_AUTH=managed-identity", () => {
    const issues = validateRuntimeEnv(
      { PI_MODEL_AUTH: "managed-identity", PI_OPENAI_BASE_URL: "https://x", PI_OPENAI_MODEL: "gpt-4.1-mini" },
      { mock: false },
    );
    assert.deepEqual(issues.filter((i) => i.severity === "error"), []);
  });

  it("still requires base url + model when PI_MODEL_AUTH=managed-identity", () => {
    const issues = validateRuntimeEnv({ PI_MODEL_AUTH: "managed-identity" }, { mock: false });
    const errorNames = issues.filter((i) => i.severity === "error").map((i) => i.name).sort();
    assert.deepEqual(errorNames, ["PI_OPENAI_BASE_URL", "PI_OPENAI_MODEL"]);
  });

  it("does not warn on AGENT_* (populated by Foundry, informational only)", () => {
    const issues = validateRuntimeEnv(
      { AGENT_FOO_NAME: "x", AGENT_FOO_VERSION: "1", PI_MOCK: "1" },
      { mock: true },
    );
    const agentIssues = issues.filter((i) => i.name.startsWith("AGENT_"));
    assert.deepEqual(agentIssues, []);
  });

  it("allows the FOUNDRY_PROJECT_ENDPOINT exception without a warning", () => {
    const issues = validateRuntimeEnv({ FOUNDRY_PROJECT_ENDPOINT: "https://x", PI_MOCK: "1" }, { mock: true });
    assert.deepEqual(issues.filter((i) => i.name === "FOUNDRY_PROJECT_ENDPOINT"), []);
  });

  it("does not warn on documented FOUNDRY_ aliases used by the paseo shim", () => {
    const issues = validateRuntimeEnv(
      { FOUNDRY_MODEL: "gpt-4.1-mini", FOUNDRY_INVOCATIONS_ENDPOINT: "https://x", PI_MOCK: "1" },
      { mock: true },
    );
    assert.deepEqual(issues.filter((i) => i.severity === "warning"), []);
  });

  it("warns on undocumented FOUNDRY_-prefixed user variables", () => {
    const issues = validateRuntimeEnv({ FOUNDRY_MY_CUSTOM_THING: "x", PI_MOCK: "1" }, { mock: true });
    const warnings = issues.filter((i) => i.severity === "warning" && i.name === "FOUNDRY_MY_CUSTOM_THING");
    assert.equal(warnings.length, 1);
  });

  it("errors on an unknown HARNESS value", () => {
    const issues = validateRuntimeEnv({ HARNESS: "bogus", PI_MOCK: "1" }, { mock: true });
    const harnessErrors = issues.filter((i) => i.severity === "error" && i.name === "HARNESS");
    assert.equal(harnessErrors.length, 1);
  });

  it("treats a blank HARNESS as the default pi (azd expands unset vars to '')", () => {
    const issues = validateRuntimeEnv({ HARNESS: "", PI_MOCK: "1" }, { mock: true });
    const harnessErrors = issues.filter((i) => i.severity === "error" && i.name === "HARNESS");
    assert.deepEqual(harnessErrors, []);
  });

  it("rejects HARNESS=copilot with PI_MODEL_AUTH=managed-identity (BYOK is apikey only)", () => {
    const issues = validateRuntimeEnv(
      { HARNESS: "copilot", PI_MODEL_AUTH: "managed-identity", PI_OPENAI_BASE_URL: "https://x", PI_OPENAI_MODEL: "gpt-4.1-mini" },
      { mock: false },
    );
    const authErrors = issues.filter((i) => i.severity === "error" && i.name === "PI_MODEL_AUTH");
    assert.equal(authErrors.length, 1);
    // copilot has no keyless path, so the API key is still required.
    assert.ok(issues.some((i) => i.severity === "error" && i.name === "PI_OPENAI_API_KEY"));
  });

  it("accepts HARNESS=copilot with the apikey triple", () => {
    const issues = validateRuntimeEnv(
      { HARNESS: "copilot", PI_OPENAI_API_KEY: "sk-x", PI_OPENAI_BASE_URL: "https://x", PI_OPENAI_MODEL: "gpt-4.1-mini" },
      { mock: false },
    );
    assert.deepEqual(issues.filter((i) => i.severity === "error"), []);
  });
});
