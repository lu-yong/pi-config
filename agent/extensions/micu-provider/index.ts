import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("micu", {
    name: "Micu AI",
    // Update the baseUrl to match Micu's actual API endpoint
    baseUrl: "https://www.micuapi.ai/v1",
    apiKey: "$MICU_API_KEY",
    api: "openai-responses",
    models: [
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        reasoning: true,
        thinkingLevelMap: {
          off: "none",
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        input: ["text", "image"],
        cost: { input: 0.07, output: 0.42, cacheRead: 0.007, cacheWrite: 0.0087 },
        contextWindow: 272000,
        maxTokens: 16384,
      },
      {
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        reasoning: true,
        thinkingLevelMap: {
          off: "none",
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        input: ["text", "image"],
        cost: { input: 0.7, output: 4.2, cacheRead: 0.07, cacheWrite: 0.0875 },
        contextWindow: 272000,
        maxTokens: 16384,
      },
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        reasoning: true,
        thinkingLevelMap: {
          off: "none",
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        input: ["text", "image"],
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 272000,
        maxTokens: 16384,
      },
    ],
  });
}
