// Returns key status and usage for this browser. Plaintext keys stay on the server.
import { pickModels, requireSession } from "@/lib/server/auth";
import { deviceOf } from "@/lib/server/device";
import { apiKeyDevice, getStore, type ApiKeyInfo, type DeviceInfo, type MonthUsage } from "@/lib/server/store";
import { KRW_PER_USD, MODEL_INFO } from "@/lib/ai/models-info";
import { providerFor, type AiProvider } from "@/lib/ai/models";

export const runtime = "nodejs";

function publicKey(info: ApiKeyInfo) {
  return info.saved
    ? { saved: true, last4: info.last4 ?? "", savedAt: info.savedAt ?? "", broken: !!info.broken }
    : { saved: false };
}

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  try {
    const store = getStore();
    const device = await deviceOf(req);
    const empty: DeviceInfo = { apiKey: { saved: false }, models: null };
    const [claude, gpt] = device
      ? await Promise.all([store.deviceInfo(device), store.deviceInfo(apiKeyDevice(device, "openai"))])
      : [empty, empty];
    const models = pickModels(claude.models);
    const apiKeys = { anthropic: publicKey(claude.apiKey), openai: publicKey(gpt.apiKey) };
    const [anthropicUsage, openaiUsage] = await Promise.all([claude, gpt].map((info) =>
      info.apiKey.saved && info.apiKey.tag ? store.monthlyUsage(info.apiKey.tag, 12) : Promise.resolve([] as MonthUsage[]),
    ));
    const usageByProvider = { anthropic: anthropicUsage, openai: openaiUsage };
    const totals = new Map<string, MonthUsage>();
    for (const row of [...anthropicUsage, ...openaiUsage]) {
      const month = totals.get(row.month) ?? { month: row.month, calls: 0, usd: 0 };
      month.calls += row.calls;
      month.usd += row.usd;
      totals.set(row.month, month);
    }
    const selected = [...new Set<AiProvider>(Object.values(models).map(providerFor))];
    const canRead = selected.every((provider) => apiKeys[provider].saved && !apiKeys[provider].broken);
    const cacheScope = selected.map((provider) => {
      const key = apiKeys[provider];
      return `${provider}:${key.savedAt ?? ""}:${key.last4 ?? ""}`;
    }).join("|");
    return Response.json({
      apiKey: apiKeys.anthropic,
      apiKeys,
      canRead,
      cacheScope,
      models,
      modelOptions: MODEL_INFO,
      usage: [...totals.values()].sort((a, b) => b.month.localeCompare(a.month)).slice(0, 12),
      usageByProvider,
      krwPerUsd: KRW_PER_USD,
      hwpxEndpoint: process.env.EXAM_STORE === "local" ? "/api/dev-hwpx" : "/api/hwpx",
    });
  } catch (err) {
    console.error("설정 읽기 실패", err);
    return Response.json({ error: "설정을 읽지 못했습니다. 잠시 뒤 다시 해 주세요." }, { status: 503 });
  }
}
