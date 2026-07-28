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
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 272000,
        maxTokens: 16384,
      },
      // ── Claude models via anthropic-messages API ──
      {
        id: "claude-fable-5",
        name: "Claude Fable 5 (via AnyRouter)",
        baseUrl: "https://anyrouter.top",
        api: "anthropic-messages",
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        input: ["text", "image"],
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
        contextWindow: 1000000,
        maxTokens: 128000,
      },
      {
        id: "claude-opus-5",
        name: "Claude Opus 5 (via AnyRouter)",
        baseUrl: "https://anyrouter.top",
        api: "anthropic-messages",
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 1000000,
        maxTokens: 128000,
      },
    ],
  });
}
