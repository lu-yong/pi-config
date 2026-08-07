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
        contextWindow: 1050000,
        maxTokens: 128000,
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
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25,
          tiers: [
            {
              inputTokensAbove: 272000,
              input: 10,
              output: 45,
              cacheRead: 1,
              cacheWrite: 12.5,
            },
          ],
        },
        contextWindow: 1050000,
        maxTokens: 128000,
      },
    ],
  });
}
