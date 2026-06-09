import { createCopilotSdkAdapter } from "./copilot-sdk.mjs";
import { createCodexSdkAdapter } from "./codex-sdk.mjs";
import { createPiRpcAdapter } from "./pi-rpc.mjs";

// Normalized harness adapter interface:
//   init()                  optional lifecycle, called once at startup
//   configureModelProvider() optional, called once at startup
//   invoke(prompt, options)  required, runs one turn
//   dispose()               optional, called on shutdown
//
// Default harness is pi; HARNESS=copilot selects the Copilot SDK adapter,
// HARNESS=codex selects the OpenAI Codex SDK adapter.
export const SUPPORTED_HARNESSES = ["pi", "copilot", "codex"];

export function createAdapter(harness, ctx) {
  switch (harness) {
    case "pi": {
      const pi = createPiRpcAdapter(ctx);
      return {
        init: async () => {},
        configureModelProvider: pi.configureFoundryOpenAIProvider,
        invoke: pi.invoke,
        dispose: async () => {},
      };
    }
    case "copilot":
      return createCopilotSdkAdapter(ctx);
    case "codex":
      return createCodexSdkAdapter(ctx);
    default:
      throw new Error(`unknown HARNESS=${harness}; supported: ${SUPPORTED_HARNESSES.join(", ")}`);
  }
}
