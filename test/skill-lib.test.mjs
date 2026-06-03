import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDotenv, isSecretName, redact, parseArgs, inferHarnessFromRuntimeImage, runtimeImageFromDockerfileText } from "../.agents/skills/pi-foundry/scripts/_lib.mjs";

describe("parseDotenv", () => {
  it("parses bare KEY=value lines", () => {
    assert.deepEqual(parseDotenv("FOO=bar\nBAZ=qux"), { FOO: "bar", BAZ: "qux" });
  });

  it("ignores comments and blank lines", () => {
    const text = `# header\n\nFOO=bar\n# inline comment\nBAZ=qux\n`;
    assert.deepEqual(parseDotenv(text), { FOO: "bar", BAZ: "qux" });
  });

  it("strips matching single or double quotes but preserves literal $", () => {
    // azd's `KEY='$web'` form must round-trip the literal `$web`, otherwise a
    // value like `$web` gets double-expanded by shell consumers.
    const text = `A="hello"\nB='world'\nC='$web'\nD="$plain"\n`;
    assert.deepEqual(parseDotenv(text), { A: "hello", B: "world", C: "$web", D: "$plain" });
  });

  it("trims whitespace around the value but preserves embedded spaces", () => {
    const text = `PI_ARGS=  --mode rpc --no-session \n`;
    assert.deepEqual(parseDotenv(text), { PI_ARGS: "--mode rpc --no-session" });
  });

  it("ignores lines without =", () => {
    assert.deepEqual(parseDotenv("FOO\nBAR=baz\n"), { BAR: "baz" });
  });

  it("ignores lines whose key is not a valid identifier", () => {
    assert.deepEqual(parseDotenv("1FOO=bar\nFOO-BAR=baz\nOK=yes\n"), { OK: "yes" });
  });

  it("tolerates CRLF line endings", () => {
    assert.deepEqual(parseDotenv("FOO=bar\r\nBAZ=qux\r\n"), { FOO: "bar", BAZ: "qux" });
  });
});

describe("isSecretName", () => {
  it("identifies common secret-shaped names case-insensitively", () => {
    for (const name of ["PI_OPENAI_API_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "MY_SECRET", "AZURE_CREDENTIAL"]) {
      assert.equal(isSecretName(name), true, name);
    }
  });

  it("does not flag plain config names", () => {
    for (const name of ["PI_OPENAI_MODEL", "AZURE_LOCATION", "AZURE_CONTAINER_REGISTRY_ENDPOINT", "PI_ARGS"]) {
      assert.equal(isSecretName(name), false, name);
    }
  });
});

describe("redact", () => {
  it("returns <unset> for falsy values", () => {
    assert.equal(redact(""), "<unset>");
    assert.equal(redact(undefined), "<unset>");
  });

  it("returns <set> for short values to avoid leaking them", () => {
    assert.equal(redact("12345678"), "<set>");
  });

  it("shows first 4 + last 4 chars for long values", () => {
    assert.equal(redact("sk-abcdefghijklmnop"), "sk-a…mnop");
  });
});

describe("parseArgs", () => {
  it("parses key/value flags", () => {
    const result = parseArgs(["--agent-name", "foo", "--cpu", "2"]);
    assert.equal(result["agent-name"], "foo");
    assert.equal(result.cpu, "2");
    assert.deepEqual(result._, []);
  });

  it("treats listed names as boolean flags", () => {
    const result = parseArgs(["--force", "--dry-run", "--agent-name", "foo"], { flags: ["force", "dry-run"] });
    assert.equal(result.force, true);
    assert.equal(result["dry-run"], true);
    assert.equal(result["agent-name"], "foo");
  });

  it("collects positional args in _", () => {
    const result = parseArgs(["first", "--name", "x", "second"]);
    assert.deepEqual(result._, ["first", "second"]);
    assert.equal(result.name, "x");
  });

  it("recognizes --help / -h", () => {
    assert.equal(parseArgs(["--help"]).help, true);
    assert.equal(parseArgs(["-h"]).help, true);
  });

  it("throws when a non-flag option is missing its value", () => {
    assert.throws(() => parseArgs(["--cpu"]), /Missing value for --cpu/);
    // The next token starting with -- should also be treated as missing-value, not consumed.
    assert.throws(() => parseArgs(["--cpu", "--memory", "4Gi"]), /Missing value for --cpu/);
  });
});

describe("inferHarnessFromRuntimeImage", () => {
  it("maps pi-foundry-runtime to pi", () => {
    assert.equal(inferHarnessFromRuntimeImage("ghcr.io/1openwindow/pi-foundry-runtime:0.1"), "pi");
    assert.equal(inferHarnessFromRuntimeImage("myacr.azurecr.io/pi-foundry-runtime:latest"), "pi");
  });

  it("maps ghcp-foundry-runtime to copilot", () => {
    assert.equal(inferHarnessFromRuntimeImage("ghcr.io/1openwindow/ghcp-foundry-runtime:0.1"), "copilot");
    assert.equal(inferHarnessFromRuntimeImage("myacr.azurecr.io/ghcp-foundry-runtime@sha256:abc"), "copilot");
  });

  it("returns unknown for unrecognized or renamed images", () => {
    assert.equal(inferHarnessFromRuntimeImage("myacr.azurecr.io/my-agent-runtime:latest"), "unknown");
    assert.equal(inferHarnessFromRuntimeImage(""), "unknown");
    assert.equal(inferHarnessFromRuntimeImage(undefined), "unknown");
  });

  it("does not confuse a registry port with an image tag", () => {
    assert.equal(inferHarnessFromRuntimeImage("localhost:5000/ghcp-foundry-runtime"), "copilot");
  });
});

describe("runtimeImageFromDockerfileText", () => {
  it("resolves FROM ${PI_FOUNDRY_RUNTIME_IMAGE} via the ARG default", () => {
    const text = "ARG PI_FOUNDRY_RUNTIME_IMAGE=myacr.azurecr.io/ghcp-foundry-runtime:1.0\nFROM ${PI_FOUNDRY_RUNTIME_IMAGE}\nCOPY . /workspace\n";
    assert.equal(runtimeImageFromDockerfileText(text), "myacr.azurecr.io/ghcp-foundry-runtime:1.0");
  });

  it("prefers a literal FROM image when the user inlined it", () => {
    const text = "FROM myacr.azurecr.io/pi-foundry-runtime:2.0\nCOPY . /workspace\n";
    assert.equal(runtimeImageFromDockerfileText(text), "myacr.azurecr.io/pi-foundry-runtime:2.0");
  });

  it("returns undefined when no image is present", () => {
    assert.equal(runtimeImageFromDockerfileText("# just a comment\n"), undefined);
    assert.equal(runtimeImageFromDockerfileText(""), undefined);
  });
});
