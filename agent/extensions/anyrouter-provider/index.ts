import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("anyrouter", {
    name: "AnyRouter",
    baseUrl: "https://anyrouter.top/v1",
    apiKey: "$ANYROUTER_API_KEY",
    api: "openai-responses",
    models: [
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol (via AnyRouter)",
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: "high",
          xhigh: null,
          max: null,
        },
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 16384,
      },
    ],
  });
}
