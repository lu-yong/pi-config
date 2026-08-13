import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("micu-xai", {
    name: "Micu xAI",
    baseUrl: "https://www.micuapi.ai/v1",
    apiKey: "$MICU_XAI_API_KEY",
    api: "openai-responses",
    models: [
      {
        id: "grok-4.6",
        name: "Grok 4.6",
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: null,
        },
        input: ["text", "image"],
        cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
        contextWindow: 500000,
        maxTokens: 128000,
      },
    ],
  });
}
