import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("micu", {
    name: "Micu AI",
    // Update the baseUrl to match Micu's actual API endpoint
    baseUrl: "https://www.micuapi.ai/v1",
    apiKey: "$MICU_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        reasoning: true,
        thinkingLevelMap: {
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "extra_high",
          max: null,
        },
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 16384,
      },
      {
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        reasoning: true,
        thinkingLevelMap: {
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "extra_high",
          max: null,
        },
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 16384,
      },
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        reasoning: true,
        thinkingLevelMap: {
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "extra_high",
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
