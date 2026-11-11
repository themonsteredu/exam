export const CLAUDE_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5"] as const;
export const OPENAI_MODELS = ["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"] as const;
export const MODELS = [...CLAUDE_MODELS, ...OPENAI_MODELS] as const;
export type ModelId = (typeof MODELS)[number];
export type AiProvider = "anthropic" | "openai";

export const PROVIDER_NAMES: Record<AiProvider, string> = { anthropic: "Claude", openai: "GPT" };

export function isModel(value: unknown): value is ModelId {
  return typeof value === "string" && (MODELS as readonly string[]).includes(value);
}

export function isProvider(value: unknown): value is AiProvider {
  return value === "anthropic" || value === "openai";
}

export function providerFor(model: string): AiProvider {
  return model.startsWith("gpt-") ? "openai" : "anthropic";
}

export function validApiKeyFormat(key: string, provider: AiProvider): boolean {
  return provider === "anthropic"
    ? /^sk-ant-(?!admin)[A-Za-z0-9_-]{20,300}$/.test(key)
    : /^sk-(?!ant-|admin-)[A-Za-z0-9_-]{20,1000}$/.test(key);
}

// Standard API rates per million tokens, checked against the official model pages on 2026-11-11.
export const OPENAI_PRICES: Record<(typeof OPENAI_MODELS)[number], { input: number; cachedInput: number; output: number }> = {
  "gpt-6.1-terra": { input: 1, cachedInput: 0.05, output: 5 },
  "gpt-6.1-sol": { input: 2, cachedInput: 0.1, output: 10 },
  "gpt-6-astra": { input: 10, cachedInput: 1, output: 50 },
};
