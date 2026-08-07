import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("cola", {
    name: "Cola AI",
    // Update the baseUrl to match Cola's actual API endpoint
    baseUrl: "https://code28.ccwu.cc/v1",
    apiKey: "$COLA_API_KEY",
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
        cost: {
          input: 0.07,
          output: 0.42,
          cacheRead: 0.007,
          cacheWrite: 0.0875,
          tiers: [
            {
              inputTokensAbove: 272000,
              input: 0.14,
              output: 0.63,
              cacheRead: 0.014,
              cacheWrite: 0.175,
            },
          ],
        },
        contextWindow: 1050000,
        maxTokens: 128000,
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
        cost: {
          input: 0.7,
          output: 4.2,
          cacheRead: 0.07,
          cacheWrite: 0.0875,
          tiers: [
            {
              inputTokensAbove: 272000,
              input: 1.4,
              output: 6.3,
              cacheRead: 0.14,
              cacheWrite: 0.175,
            },
          ],
        },
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
        cost: {
          input: 1.75,
          output: 10.5,
          cacheRead: 0.175,
          cacheWrite: 2.1875,
          tiers: [
            {
              inputTokensAbove: 272000,
              input: 3.5,
              output: 15.75,
              cacheRead: 0.35,
              cacheWrite: 4.375,
            },
          ],
        },
        contextWindow: 1050000,
        maxTokens: 128000,
      },
    ],
  });
}
